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
  // Gate round 3 P1 — `user_roles` rows this file seeds so a role-node approver is PRODUCTION-SHAPED
  // (a server-written membership record), not merely `roles=admin` inside a dev token. Tracked for
  // cleanup exactly like the `users` / `user_permissions` rows above: `user_roles` has no FK to
  // `users`, so deleting the user row does NOT take the membership with it.
  const grantedRoleMemberships: Array<{ userId: string; roleId: string }> = []

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
      if (createdDelegationIds.size > 0) {
        // Lock §2-G3 第三句 fixtures — these are 'all'-scope delegation rows, i.e. GLOBAL config
        // that substitutes assignees for every later suite naming the same delegator. They are
        // deleted FIRST, before any FK-entangled table, because MEASURED on 2026-09-20 they are
        // NOT independent of the deletes below: under mutation G-1 a negative-control leg whose
        // creation unexpectedly SUCCEEDED left a cancel round behind, the `approval_instances`
        // DELETE then raised `23503 approval_rounds_document_id_fkey`, the whole cleanup aborted,
        // and the surviving rows failed `approval-delegation-seam`'s `toEqual({A: D})` in a later
        // file — the exact fixture-residue family the binding verification report §4 was polluted
        // by once already. Ordering them first makes the contagious rows survive-proof; the
        // `registerUnexpectedlyCreatedRound` helper below attacks the same defect from the
        // other end.
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
      if (grantedRoleMemberships.length > 0) {
        await pool().query(
          'DELETE FROM user_roles WHERE user_id = ANY($1::text[]) AND role_id = ANY($2::text[])',
          [grantedRoleMemberships.map((m) => m.userId), [...new Set(grantedRoleMemberships.map((m) => m.roleId))]],
        )
        grantedRoleMemberships.length = 0
      }
    } finally {
      await server?.stop()
    }
  })

  async function grantWrite(userId: string): Promise<void> {
    grantedUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  /**
   * Gate round 3 P1 — seed the SERVER-SIDE record of a role membership.
   *
   * `GET /api/auth/dev-token` mints `roles=admin` into the JWT for every id this file authenticates
   * (see `authToken`), and `assignmentMatchesActor` matches a ROLE seat on that token claim — so a
   * fixture approver could occupy a role seat while the DATABASE knew nothing about it. Production
   * never has that shape: `AuthService.createToken` signs `role: user.role`, and `resolveRbacProfile`
   * derives it from `users.role` + `user_roles`; no production path mints the `roles` array claim at
   * all. The seat credential the candidate now requires reads that persisted substrate, so the
   * fixtures are made production-shaped rather than the credential made fail-open — the same
   * treatment (and the same reason) as this file's `ensureLocalUserRow` delta.
   *
   * Returns nothing on purpose: a leg that wants the ABSENCE of a membership record simply does not
   * call this, and 负控 `N16(a)` pins what that absence now costs.
   */
  async function grantRoleMembership(userId: string, roleId: string): Promise<void> {
    grantedRoleMemberships.push({ userId, roleId })
    await pool().query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, roleId],
    )
    const row = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_roles WHERE user_id = $1 AND role_id = $2`,
      [userId, roleId],
    )
    // The leg's own precondition, asserted rather than assumed (the "ineffective mutation" family):
    // if this INSERT silently did nothing, every credential assertion below would pass or fail for
    // the wrong reason.
    expect(row.rows[0]?.n).toBe('1')
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
  // Lock §2-G3 THIRD sentence (lock:74) 「历史委托不自动成为当前授权」 — READING (a): the seat is the
  // ORIGINAL APPROVER (委托 = 履职代理, not a transfer of authority).
  //
  // Independent verification 2026-09-19 (`verify-c1-lock-g3-delegation-20260919.md`) measured, on a
  // real DB, that before this change the four delegation states below produce a BYTE-IDENTICAL seat
  // set (`[D]`, 201) — today's seat derivation never reads the delegation at all. That "identical" IS
  // the defect, so a single 有效-delegation case would have ZERO discriminating power: all four legs
  // are required, and they are written as four separate `it()`s so a partial regression names itself.
  //
  // Under reading (a) all four legs answer `[A]`. That is deliberate and is NOT an argument for
  // dropping legs: they do not prove that (a) READS the delegation state (it does not — it reads the
  // frozen `delegatedFrom` provenance), they prove the seat no longer TRACKS it. The leg that
  // distinguishes (a) from reading (b) 「委托今天仍有效才给 D」 is P4 below: (a) answers `[A]`,
  // (b) answers `[D]`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  type DelegationLegState = 'valid' | 'revoked' | 'expired' | 'scope_mismatch' | 'scope_exact'

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
  async function delegatedApprovedOriginal(
    label: string,
    // `approveVia: 'legacy'` is the G-4 leg (README §2.3, the DISCLOSED gap): the legacy
    // `POST /api/approvals/:id/approve` route copies `metadata` verbatim out of the REQUEST BODY
    // (`routes/approvals.ts:2877-2879`), so its approve row carries NO `nodeKey` and the restore
    // join's `a.node_key = r.metadata->>'nodeKey'` conjunction cannot match. Production-shaped:
    // the row is written by the shipped route, not hand-edited into the table afterwards.
    // `legacyNodeKey` injects `metadata.nodeKey` into the LEGACY request body. That body is copied
    // VERBATIM into `approval_records.metadata` by the shipped route, so this is not a hand-edit of
    // the table — it is exactly what any holder of `approvals:act` can send today.
    options: { approveVia?: 'actions' | 'legacy'; legacyNodeKey?: string } = {},
  ): Promise<{
    documentId: string
    requesterId: string
    delegatorA: string
    delegateeD: string
    delegationId: string
    templateId: string
  }> {
    const approveVia = options.approveVia ?? 'actions'
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

    if (approveVia === 'legacy') {
      const versionRow = await pool().query<{ version: number }>(
        `SELECT version FROM approval_instances WHERE id = $1`,
        [documentId],
      )
      const legacyApprove = await jsonRequest(baseUrl, `/api/approvals/${documentId}/approve`, tokenD, {
        method: 'POST',
        body: {
          version: versionRow.rows[0].version,
          ...(options.legacyNodeKey !== undefined ? { metadata: { nodeKey: options.legacyNodeKey } } : {}),
        },
      })
      expect(legacyApprove.status, await legacyApprove.clone().text()).toBe(200)
      // The leg's OWN precondition, asserted rather than assumed: the legacy route deactivates no
      // assignment (it only UPDATEs the instance and INSERTs the record), so the delegated row is
      // still there for the join to match on `(instance, assignee)` and MISS on `node_key`. If a
      // future change ever deactivates or rewrites it, the seat below would flip to A for a
      // completely different mechanism and would read as "the disclosed gap closed".
      const seatAfterLegacy = await pool().query<{ delegated_from: string | null; node_key: string | null }>(
        `SELECT metadata->>'delegatedFrom' AS delegated_from, node_key
           FROM approval_assignments WHERE instance_id = $1`,
        [documentId],
      )
      expect(seatAfterLegacy.rows).toEqual([{ delegated_from: delegatorA, node_key: 'approval_a' }])
    } else {
      const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approveResponse.status, await approveResponse.clone().text()).toBe(200)
    }

    // The audit trail the seat query reads names D, and A appears in it nowhere — the provenance the
    // restore depends on lives ONLY in `approval_assignments`. The `node_key` the row carries is the
    // leg's own precondition, asserted (not assumed) per writer: the template runtime writes
    // `approval_a`, the legacy route writes NOTHING at all.
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve'`,
      [documentId],
    )
    expect(records.rows).toEqual([
      {
        actor_id: delegateeD,
        node_key: approveVia === 'legacy' ? (options.legacyNodeKey ?? null) : 'approval_a',
      },
    ])
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
    originalTemplateId: string,
  ): Promise<void> {
    const statements: Record<DelegationLegState, { sql: string; params: unknown[] } | null> = {
      valid: null,
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
      scope_exact: {
        // The MIRROR of the leg above: `scope='template'` pointing at THIS document's own template,
        // still active and in-window — i.e. a delegation that is valid AND in scope by every
        // predicate `resolveActiveDelegationMap` applies. Reading (b) answers `[D]` here (its
        // `P11(b)`); reading (a) answers `[A]`, the same as every other leg.
        //
        // Stated precisely, because it is the honest limit of this leg under (a): it is NOT
        // evidence that any templateId scoping was handled correctly, because (a) never calls
        // `resolveActiveDelegationMap` at all. What it IS: the leg that refutes 「席位跟着今天仍
        // 然完全有效的委托走」 — today's shipped behaviour answers `[D]` here too, so `[A]` is a
        // real discrimination against the BEFORE state, not a restatement of the other legs.
        sql: `UPDATE approval_delegations SET scope = 'template', scope_template_id = $2 WHERE id = $1`,
        params: [delegationId, originalTemplateId],
      },
    }
    const statement = statements[leg]
    if (!statement) return
    const applied = await pool().query(statement.sql, statement.params)
    expect(applied.rowCount, leg).toBe(1)
  }

  /**
   * A negative control whose creation UNEXPECTEDLY succeeds has still written rows, and those rows
   * are not registered for cleanup by the assertion that is about to fail. Registering them here is
   * what stops a red run from poisoning the shared DB for every later file (measured: see the
   * `afterAll` comment above — the unregistered `approval_rounds` row is what raised the FK error
   * that aborted cleanup entirely).
   */
  async function registerUnexpectedlyCreatedRound(documentId: string, createdInstanceId: string): Promise<void> {
    createdApprovalIds.add(createdInstanceId)
    const rows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      documentId,
    ])
    for (const row of rows.rows) createdRoundIds.add(row.id)
  }

  /** Opens the cancel round for a delegated original in the named delegation state, returns its seats. */
  async function cancelRoundSeatsForLeg(
    label: string,
    leg: DelegationLegState,
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
    await applyDelegationLeg(fixture.delegationId, leg, fixture.templateId)
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

  it('§2-G3 第三句 正控 P4(a) — 委托仍然有效:席位仍是原审批人 A(委托是履职代理,不是授权转移);这是与读法 (b) 唯一分歧的一腿', async () => {
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-valid', 'valid')
    // Discriminating both ways: `[A]` refutes today's shipped behaviour (`[D]`) AND reading (b),
    // which answers `[D]` for this leg alone.
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
  })

  it('§2-G3 第三句 正控 P5(a) — 委托已撤销(active = FALSE):席位是 A', async () => {
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-revoked', 'revoked')
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
  })

  it('§2-G3 第三句 正控 P6(a) — 委托窗口已过期(end_at 在过去):席位是 A', async () => {
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-expired', 'expired')
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
  })

  it('§2-G3 第三句 正控 P7(a) — 委托作用域不覆盖本单模板(scope=template 指向别的模板;跨组织腿的替代物,见 applyDelegationLeg 文档):席位是 A', async () => {
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-scope', 'scope_mismatch')
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
  })

  it('§2-G3 第三句 负控 N5(a) — 资格闸的人口跟着席位走:停权「原审批人 A」现在阻断(409 SEAT_INELIGIBLE,零行);实测今天不阻断', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-gateA')
    const deactivated = await pool().query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [fixture.delegatorA])
    expect(deactivated.rowCount).toBe(1)

    const service = new ApprovalProductService()
    let thrown: unknown
    try {
      const unexpected = await service.createCancelRoundInstance(fixture.documentId, { userId: fixture.requesterId })
      await registerUnexpectedlyCreatedRound(fixture.documentId, unexpected.id)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeTruthy()
    const failure = thrown as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> }
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_SEAT_INELIGIBLE')
    expect(failure.details).toEqual({ ineligibleCount: 1, reasons: ['inactive'] })
    // Same values-free posture as N1 — the refusal names a category, never a person.
    expect(JSON.stringify(failure.details)).not.toContain(fixture.delegatorA)
    expect(String(failure.message)).not.toContain(fixture.delegatorA)
    await expectZeroCancelRoundRows(fixture.documentId)
  })

  it('§2-G3 第三句 正控 P8(a) — 反向不对称:停权「被委托人 D」不再阻断,席位是 A(实测今天正相反:停 D 阻断、停 A 放行)', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-gateD')
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
  // 门审用例:候选补丁自带 6 条之外,本轮(2026-09-20,第一次真库实跑)补齐的 5 条腿。
  //
  // 三条按门审的腿表补齐,把第三句的席位推导和这条方法**已有的另外两个过滤器**放在同一张单据上
  // 求值(补丁里没有):作用域正好命中 / 哨兵 / 零席位。
  // 另两条是 README §2.2 自己点名「**从未被实测**」的那条 `AND a.node_key = r.metadata->>'nodeKey'`
  // 合取的 **两个相反方向的 oracle** —— 删掉该合取,一条因为多还原而红,另一条因为少还原而红:
  //   · P11(a) 兄弟席位(D 在节点 1 是 A 的代理、在节点 2 有自己的席位)⇒ 席位必须是 {A, D} 两人;
  //   · P12(a) legacy 无 `nodeKey` 的 approve 行 ⇒ 席位保持 actor(= 今天的行为,已披露的缺口)。
  // 这两条在「把整个 join 退回基线」那条 mutation 下的红绿与此处无关,逐条读数以验证 MD Part N 的
  // mutation 台账为准(实测),不在这里预言。
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** Publishes a template with a caller-supplied graph (the shape helpers above are one-node only). */
  async function publishGraphTemplate(
    adminToken: string,
    graph: ReturnType<typeof oneNodeGraph>,
    label: string,
  ): Promise<string> {
    const templateKey = `wi4-creation-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'WI-4 cancel-round creation fixture (delegation legs)',
        description: 'approval-cancel-round-creation.db.test.ts',
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

  it('§2-G3 第三句 正控 P9(a) — 委托作用域**正好命中**本单模板、且今天仍然完全有效:席位仍是 A(读法 (b) 在这一腿答 [D])', async () => {
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-scopeexact', 'scope_exact')
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
  })

  /**
   * An approved original with TWO SEQUENTIAL user nodes: `approval_a` names A (substituted to D by
   * the delegation) and `approval_b` names D HIMSELF. Both approve rows therefore carry
   * `actor_id = D`, and only the first of them has a `delegatedFrom` assignment behind it.
   *
   * This is the fixture the `node_key` conjunction exists for (README §2.2): without it the join
   * matches D's OWN seat at `approval_b` against the DELEGATED assignment row at `approval_a`, and
   * D's own seat is folded into A — one seat where there must be two. 会签门槛真的会被降低。
   */
  async function delegatedSiblingSeatOriginal(
    label: string,
    // `secondNodeVia: 'legacy'` sends the SECOND node through the legacy route, optionally naming a
    // `nodeKey` in the request body — the corroboration residual pinned by 负控 `P21(a)`.
    options: { secondNodeVia?: 'actions' | 'legacy'; legacyNodeKey?: string } = {},
  ): Promise<{
    documentId: string
    requesterId: string
    delegatorA: string
    delegateeD: string
  }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-sreq-${suffix}`
    const delegatorA = `wi4-selA-${suffix}`
    const delegateeD = `wi4-selD-${suffix}`
    const adminId = `wi4-sadm-${suffix}`
    const delegationId = `wi4-sdeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)

    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )

    const templateId = await publishGraphTemplate(
      adminToken,
      {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_a',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [delegatorA], approvalMode: 'single' },
          },
          {
            key: 'approval_b',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [delegateeD], approvalMode: 'single' },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
          { key: 'e-b-end', source: 'approval_b', target: 'end' },
        ],
      } as ReturnType<typeof oneNodeGraph>,
      label,
    )

    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    const firstApprove = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(firstApprove.status, `approval_a: ${await firstApprove.clone().text()}`).toBe(200)
    if (options.secondNodeVia === 'legacy') {
      const versionRow = await pool().query<{ version: number }>(
        `SELECT version FROM approval_instances WHERE id = $1`,
        [documentId],
      )
      const legacy = await jsonRequest(baseUrl, `/api/approvals/${documentId}/approve`, tokenD, {
        method: 'POST',
        body: {
          version: versionRow.rows[0].version,
          ...(options.legacyNodeKey !== undefined ? { metadata: { nodeKey: options.legacyNodeKey } } : {}),
        },
      })
      expect(legacy.status, `approval_b (legacy): ${await legacy.clone().text()}`).toBe(200)
    } else {
      const secondApprove = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(secondApprove.status, `approval_b: ${await secondApprove.clone().text()}`).toBe(200)
    }

    // 正控先行, per-node: the delegated seat and the OWN seat must both exist and must differ in
    // exactly one property — `metadata.delegatedFrom`. Without this the whole leg could pass because
    // the second node never produced a seat at all.
    const seatRows = await pool().query<{ node_key: string | null; assignee_id: string; delegated_from: string | null }>(
      `SELECT node_key, assignee_id, metadata->>'delegatedFrom' AS delegated_from
         FROM approval_assignments WHERE instance_id = $1 ORDER BY node_key`,
      [documentId],
    )
    expect(seatRows.rows).toEqual([
      { node_key: 'approval_a', assignee_id: delegateeD, delegated_from: delegatorA },
      { node_key: 'approval_b', assignee_id: delegateeD, delegated_from: null },
    ])

    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY id`,
      [documentId],
    )
    // 每条腿自己的前提,断言而不是假设:第二行的 `nodeKey` 是模板运行时写的 `approval_b`,还是
    // legacy 路由从请求体逐字搬过来的那个值。两者混淆的话,`P21(a)` 与 `P11(a)` 就分不清了。
    expect(records.rows).toEqual([
      { actor_id: delegateeD, node_key: 'approval_a' },
      {
        actor_id: delegateeD,
        node_key: options.secondNodeVia === 'legacy' ? (options.legacyNodeKey ?? null) : 'approval_b',
      },
    ])

    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')
    return { documentId, requesterId, delegatorA, delegateeD }
  }

  it('§2-G3 第三句 正控 P11(a) (G-3) — node_key 合取的 oracle:D 在节点 1 是 A 的代理、在节点 2 有自己的席位 ⇒ 席位是 {A, D} 两人,D 自己那份不被折算给 A', async () => {
    const { documentId, requesterId, delegatorA, delegateeD } = await delegatedSiblingSeatOriginal('g3dlg-sibling')

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
    // `wi4-selA-…` < `wi4-selD-…`, so the ORDER BY fixes the expected order without a sort here.
    expect(seatRows.rows.map((row) => row.assignee_id)).toEqual([delegatorA, delegateeD])
    // Stated as a count as well: the 会签 threshold on the cancel node is the thing the folded
    // join would silently halve.
    expect(seatRows.rows.length).toBe(2)
  })

  it('§2-G3 第三句 负控 P12(a) (G-4) — legacy POST /:id/approve 写的 approve 行没有 nodeKey,该行无法归属到节点席位 ⇒ **阻断**(409 SEAT_INELIGIBLE / delegate_not_seat / 零行),**谁都没停权**也照样阻断', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-legacy', { approveVia: 'legacy' })

    const service = new ApprovalProductService()
    let thrown: unknown
    try {
      const unexpected = await service.createCancelRoundInstance(fixture.documentId, { userId: fixture.requesterId })
      await registerUnexpectedlyCreatedRound(fixture.documentId, unexpected.id)
    } catch (error) {
      thrown = error
    }
    // OWNER RULING 2026-09-20, verbatim: 「原主体无法可靠还原…则阻断,不静默回退给历史被委托人」.
    // 裁决前这一腿 MEASURED 的答案是席位 `[D]` —— 即被委托人 D 留在席位上,正是被禁止的那个回退。
    // 它不再是「已登记缺口的钉子」,而是缺口**被关掉的方向**的钉子;`reason` 的值说明阻断的是
    // 「行无法归属」而不是「某个人失格」—— 本腿里没有任何人被停权。
    expect(thrown, 'creation must BLOCK, not fall back to the historical delegatee').toBeTruthy()
    const failure = thrown as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> }
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_SEAT_INELIGIBLE')
    expect(failure.details).toEqual({ ineligibleCount: 1, reasons: ['delegate_not_seat'] })
    for (const person of [fixture.delegatorA, fixture.delegateeD]) {
      expect(JSON.stringify(failure.details)).not.toContain(person)
      expect(String(failure.message)).not.toContain(person)
    }
    await expectZeroCancelRoundRows(fixture.documentId)
  })

  /**
   * An auto-approved original (one `mergeWithRequester` node ⇒ a `system:auto-approval` sentinel
   * approve row) whose SECOND node is the delegated one: it names A, and the active delegation
   * substitutes it to D. `withHuman = false` drops that second node entirely, leaving a document
   * whose whole approve trail is the sentinel.
   */
  async function delegatedAutoApprovalOriginal(
    label: string,
    withHuman: boolean,
  ): Promise<{ documentId: string; requesterId: string; delegatorA: string; delegateeD: string }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-areq-${suffix}`
    const delegatorA = `wi4-aelA-${suffix}`
    const delegateeD = `wi4-aelD-${suffix}`
    const adminId = `wi4-aadm-${suffix}`
    const delegationId = `wi4-adeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)

    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )

    const templateId = await publishAutoApprovalTemplate(adminToken, requesterId, withHuman ? delegatorA : null, label)
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    if (withHuman) {
      // 正控先行 for this shape too: the human node really is the DELEGATED one before D acts.
      const seatBefore = await pool().query<{ assignee_id: string; delegated_from: string | null }>(
        `SELECT assignee_id, metadata->>'delegatedFrom' AS delegated_from
           FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_human'`,
        [documentId],
      )
      expect(seatBefore.rows).toEqual([{ assignee_id: delegateeD, delegated_from: delegatorA }])
      const approve = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approve.status, await approve.clone().text()).toBe(200)
    }

    const statusRow = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(statusRow.rows[0]?.status).toBe('approved')

    // The sentinel MUST be in the trail — same anti-vacuity assertion `autoApprovedFixture` makes.
    const trail = await pool().query<{ actor_id: string }>(
      `SELECT DISTINCT actor_id FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY actor_id`,
      [documentId],
    )
    const actorIds = trail.rows.map((row) => row.actor_id)
    expect(actorIds).toContain('system:auto-approval')
    expect(actorIds).toEqual(withHuman ? ['system:auto-approval', delegateeD].sort() : ['system:auto-approval'])
    return { documentId, requesterId, delegatorA, delegateeD }
  }

  it('§2-G3 第三句 正控 P10(a) — 哨兵腿:同一张单据上「哨兵丢弃」与「委托还原」同时生效,席位恰好是 [A](哨兵不进席位、D 不进席位)', async () => {
    const { documentId, requesterId, delegatorA, delegateeD } = await delegatedAutoApprovalOriginal('g3dlg-sent', true)

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
    // The restore runs BEFORE the sentinel drop, so a sentinel can never be COALESCE'd into a
    // person either — asserted on the snapshot the round actually froze, not only on the seat table.
    const snapshot = await pool().query<{ requester_snapshot: Record<string, unknown> }>(
      `SELECT requester_snapshot FROM approval_instances WHERE id = $1`,
      [dto.id],
    )
    expect(JSON.stringify(snapshot.rows[0].requester_snapshot)).not.toContain('system:auto-approval')
    expect(JSON.stringify(snapshot.rows[0].requester_snapshot)).toContain(delegatorA)
  })

  it('§2-G3 第三句 负控 N6(a) — 零席位腿:整单由自动化批完(委托行存在但这张单据上没有被委托席位)⇒ 仍是 409 CANCEL_ROUND_NO_ELIGIBLE_APPROVER、零行;还原 join 不会凭空造出一个人类席位', async () => {
    const { documentId, requesterId, delegatorA, delegateeD } = await delegatedAutoApprovalOriginal('g3dlg-zero', false)

    const service = new ApprovalProductService()
    let thrown: unknown
    try {
      const unexpected = await service.createCancelRoundInstance(documentId, { userId: requesterId })
      await registerUnexpectedlyCreatedRound(documentId, unexpected.id)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeTruthy()
    const failure = thrown as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> }
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_NO_ELIGIBLE_APPROVER')
    expect(failure.details).toEqual({ reason: 'no_human_approver' })
    // 判别力,说清楚它是什么不是什么:这一腿区分「席位 = A」与「席位 = D」的方式是**两者都不成立**
    // —— 任一被坐下,创建都会成功,`thrown` 就是 falsy、零行断言就会红。它 NOT 是还原本身的 oracle。
    expect(JSON.stringify(failure.details)).not.toContain(delegatorA)
    expect(JSON.stringify(failure.details)).not.toContain(delegateeD)
    await expectZeroCancelRoundRows(documentId)
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // OWNER RULING 2026-09-20 — 读法 (a) 定案,原话逐字:
  //   「席位回原审批主体,并重验当前资格。原主体无法可靠还原或已失格则阻断,不静默回退给历史被委托人;
  //    补多人委托同一人的反例。」
  //
  // 本节此前(候选 head `cc897234eb`)钉的是**相反的**答案:legacy 语料上「不阻断、席位 [D]」被写成
  // 「已登记缺口的钉子」。裁决把那条缺口的处置从**登记**改成**阻断**,所以这些腿不是被放宽,而是被
  // **翻面**:同一组夹具,断言从「创建成功、席位 [D]」改成「409 阻断、零行、D 不在任何席位里」。
  //
  // 阻断的谓词(实现侧 `ApprovalProductService.createCancelRoundInstance`,逐 approve 行求值):
  //   · 行有 `nodeKey`,该 (instance, node, actor) 上 `delegatedFrom` 恰好 1 个 ⇒ 席位 = 该原主体;
  //   · 行有 `nodeKey`,0 个 ⇒ 席位 = actor 本人;
  //   · 行有 `nodeKey`,>1 个 ⇒ `seat_unresolvable`(需节点再入改写委托,**本轮未构造**);
  //   · 行**无** `nodeKey`,该 actor 在本实例上有 **>1** 个不同 `delegatedFrom` ⇒ `seat_unresolvable`
  //     (= owner 点名的「多人委托同一人」反例,`N9(a)` 实测);
  //   · 行**无** `nodeKey`,恰好 1 个 ⇒ `delegate_not_seat`(`N7(a)`/`N8(a)`/`P12(a)`/`P13(a)`);
  //   · 行**无** `nodeKey`,0 个 ⇒ 席位 = actor 本人 —— **爆炸半径的闸门**,`P19(a)` 钉住:
  //     legacy 路由写的 approve 行本来就**全都**没有 `nodeKey`,若少了这一臂,全仓每一张历史 legacy
  //     单据都会变成 409。这一臂是本节里唯一能把「修好了」和「把所有人都锁死了」区分开的腿。
  //
  // 定级纪律:`ineligibleCount` 在阻断臂上数的是**行**不是人(不可归属的行没有人可数),
  // `reasons` 仍然是**类别**、永不含人。
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  type CancelRoundAttempt = {
    thrown: unknown
    seats: string[]
    documentId: string
  }

  /**
   * Opens (or fails to open) a cancel round for an already-built original and reports BOTH outcomes
   * without deciding which one is right — every leg below states its own expectation. A creation that
   * unexpectedly SUCCEEDS still wrote rows, so they are registered here: the §N5 fixture-residue chain
   * (FK abort → surviving `approval_delegations` → a later file's `toEqual({A: D})` red) starts with
   * exactly this kind of unregistered row.
   */
  async function attemptCancelRound(documentId: string, requesterId: string): Promise<CancelRoundAttempt> {
    const service = new ApprovalProductService()
    let thrown: unknown
    let seats: string[] = []
    try {
      const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
      createdApprovalIds.add(dto.id)
      const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
        documentId,
      ])
      for (const row of roundRows.rows) createdRoundIds.add(row.id)
      const seatRows = await pool().query<{ assignee_id: string }>(
        `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 ORDER BY assignee_id`,
        [dto.id],
      )
      seats = seatRows.rows.map((row) => row.assignee_id)
    } catch (error) {
      thrown = error
    }
    return { thrown, seats, documentId }
  }

  /**
   * Asserts the ruling's blocking shape on an attempt: 409 `CANCEL_ROUND_SEAT_INELIGIBLE` with exactly
   * the expected values-free `details`, zero rows, and — the half that makes it the RULING's assertion
   * rather than a generic 409 — nobody named in the payload.
   */
  async function expectSeatBlock(
    attempt: CancelRoundAttempt,
    expected: { ineligibleCount: number; reasons: string[] },
    peopleThatMustNotLeak: string[],
  ): Promise<void> {
    expect(attempt.thrown, 'creation must BLOCK, not open a round').toBeTruthy()
    const failure = attempt.thrown as {
      statusCode?: number
      code?: string
      message?: string
      details?: Record<string, unknown>
    }
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_SEAT_INELIGIBLE')
    expect(failure.details).toEqual(expected)
    for (const person of peopleThatMustNotLeak) {
      expect(JSON.stringify(failure.details)).not.toContain(person)
      expect(String(failure.message)).not.toContain(person)
    }
    await expectZeroCancelRoundRows(attempt.documentId)
  }

  /**
   * A legacy-corpus delegated original with ONE named person deactivated. Shared by N7(a)/N8(a) so the
   * two legs differ in exactly one predicate (the delegation state), not in fixture plumbing.
   */
  async function legacyAttemptAfterDeactivating(
    label: string,
    who: 'delegatorA' | 'delegateeD',
    leg: DelegationLegState = 'valid',
  ): Promise<CancelRoundAttempt & { delegatorA: string; delegateeD: string }> {
    const fixture = await delegatedApprovedOriginal(label, { approveVia: 'legacy' })
    await applyDelegationLeg(fixture.delegationId, leg, fixture.templateId)
    const target = who === 'delegatorA' ? fixture.delegatorA : fixture.delegateeD
    const deactivated = await pool().query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [target])
    expect(deactivated.rowCount).toBe(1)
    // 反向正控:确认停权真的落在库里(而不是被某个 upsert 覆盖回去)。少了这一句,下面关于资格的
    // 断言可以因为「根本没停成」而平凡成立 —— 那是无效 mutation 的同族。
    const stillInactive = await pool().query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [
      target,
    ])
    expect(stillInactive.rows[0]?.is_active).toBe(false)
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    return { ...attempt, delegatorA: fixture.delegatorA, delegateeD: fixture.delegateeD }
  }

  it('§2-G3 第三句 负控 N7(a) — legacy 语料 × 停权「原审批主体 A」⇒ **阻断**(409 SEAT_INELIGIBLE / delegate_not_seat / 零行),不静默把席位留给历史被委托人 D', async () => {
    const attempt = await legacyAttemptAfterDeactivating('g3dlg-lgcygA', 'delegatorA')
    // 裁决前这一腿钉的是「创建成功、席位 [D]」。现在它钉相反的答案,并且 reason 说明**为什么**:
    // 不是「A 不在职」(A 根本没被解析出来),而是这条 approve 行无法归属到节点席位。
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['delegate_not_seat'] }, [
      attempt.delegatorA,
      attempt.delegateeD,
    ])
    expect(attempt.seats, 'a blocked creation seats nobody').toEqual([])
  })

  it('§2-G3 第三句 负控 N8(a) — legacy 语料 × 委托**已撤销** × 停权「原审批主体 A」⇒ 同样阻断,委托状态不改变答案', async () => {
    const attempt = await legacyAttemptAfterDeactivating('g3dlg-lgcygR', 'delegatorA', 'revoked')
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['delegate_not_seat'] }, [
      attempt.delegatorA,
      attempt.delegateeD,
    ])
    expect(attempt.seats).toEqual([])
    // 判别力的上限,写明而不是让它看起来比实际更强:读法 (a) **根本不读**活的委托行
    // (`resolveActiveDelegationMap` 在这条路径上零调用),所以这一腿与 N7(a) 的差别落在一个
    // **被测代码从不触碰的字段**上。它不是独立的第二个 oracle;它钉的是锁文里最刺眼的那一格
    // 现在的答案:委托已撤销、原主体已离职 ⇒ **没有人**拿到撤销轮的决定权,轮次开不出来。
  })

  it('§2-G3 第三句 负控 P13(a)(承重)— legacy 语料 × 停权「被委托人 D」:阻断的 reason 是 delegate_not_seat 而**不是** inactive —— D 从来没被坐下,所以资格闸没有在他身上跑', async () => {
    const attempt = await legacyAttemptAfterDeactivating('g3dlg-lgcygD', 'delegateeD')
    // 这条腿承的是**归因**:裁决前它答 `reasons: ['inactive']`(D 被坐下、被资格闸拒),
    // 现在答 `['delegate_not_seat']`。两个 reason 分别对应「谁被坐下」的两种答案,所以它是
    // 「席位到底给了谁」的判别腿 —— 把阻断退回「席位 [D]」的 mutation 下,它会红。
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['delegate_not_seat'] }, [
      attempt.delegatorA,
      attempt.delegateeD,
    ])
    expect(attempt.seats).toEqual([])
  })

  // ── owner 点名的反例组:多人委托同一人 ──────────────────────────────────────────────────────────

  type MultiDelegatorShape = 'two_nodes' | 'cosign_all_delegated' | 'cosign_mixed'

  /**
   * 多人委托同一人。Two (or three) DIFFERENT delegators all delegate to the SAME person D, and D is
   * the only human who ever presses a button.
   *
   * `two_nodes`: `approval_a` names A, `approval_b` names B, both substituted to D. This is the shape
   * that produces TWO distinct `delegatedFrom` values for ONE actor on ONE instance — the input the
   * ruling's 「无法可靠还原」 arm is about. `approveVia: 'mixed'` sends node 1 through the template
   * runtime (so node 2's assignment is created at all — the legacy route approves the WHOLE instance
   * in one call and would never reach node 2) and node 2 through the legacy route, which is the only
   * production writer that emits an approve row with no `nodeKey`.
   *
   * `cosign_all_delegated` / `cosign_mixed`: ONE `approvalMode: 'all'` node naming three people.
   * MEASURED, and the reason these legs pin numbers rather than assert a design: `pushResolved` dedups
   * on `user:<delegatee>`, so A→D, B→D, C→D collapses to a SINGLE assignment carrying only the FIRST
   * delegator's provenance. The 会签 threshold is therefore already 1 (not 3) when the ORIGINAL is
   * created — that collapse happens in the resolver, not in the cancel-round restore, and no evidence
   * of B's and C's seats survives anywhere for the restore to read. See the design MD §3.4 open item.
   */
  async function multiDelegatorOriginal(
    label: string,
    shape: MultiDelegatorShape,
    approveVia: 'actions' | 'mixed',
  ): Promise<{
    documentId: string
    requesterId: string
    delegators: string[]
    ownApprover: string | null
    delegateeD: string
  }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-mreq-${suffix}`
    const delegatorA = `wi4-mdlA-${suffix}`
    const delegatorB = `wi4-mdlB-${suffix}`
    const thirdPerson = `wi4-mdlC-${suffix}`
    const delegateeD = `wi4-mdlD-${suffix}`
    const adminId = `wi4-madm-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    await authToken(baseUrl, delegatorB)
    const tokenC = await authToken(baseUrl, thirdPerson)
    const tokenD = await authToken(baseUrl, delegateeD)

    // `cosign_mixed` leaves the third person UNDELEGATED — that is what makes it the leg where the
    // restored seat set has two members from two different mechanisms.
    const delegatorsOfD =
      shape === 'two_nodes'
        ? [delegatorA, delegatorB]
        : shape === 'cosign_all_delegated'
          ? [delegatorA, delegatorB, thirdPerson]
          : [delegatorA, delegatorB]
    for (const [index, delegator] of delegatorsOfD.entries()) {
      const delegationId = `wi4-mdeleg${index}-${suffix}`
      createdDelegationIds.add(delegationId)
      await pool().query(
        `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
         VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
        [delegationId, delegator, delegateeD],
      )
    }

    const graph =
      shape === 'two_nodes'
        ? {
            nodes: [
              { key: 'start', type: 'start', config: {} },
              {
                key: 'approval_a',
                type: 'approval',
                config: { assigneeType: 'user', assigneeIds: [delegatorA], approvalMode: 'single' },
              },
              {
                key: 'approval_b',
                type: 'approval',
                config: { assigneeType: 'user', assigneeIds: [delegatorB], approvalMode: 'single' },
              },
              { key: 'end', type: 'end', config: {} },
            ],
            edges: [
              { key: 'e-s-a', source: 'start', target: 'approval_a' },
              { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
              { key: 'e-b-end', source: 'approval_b', target: 'end' },
            ],
          }
        : {
            nodes: [
              { key: 'start', type: 'start', config: {} },
              {
                key: 'approval_a',
                type: 'approval',
                config: {
                  assigneeType: 'user',
                  assigneeIds: [delegatorA, delegatorB, thirdPerson],
                  approvalMode: 'all',
                },
              },
              { key: 'end', type: 'end', config: {} },
            ],
            edges: [
              { key: 'e-s-a', source: 'start', target: 'approval_a' },
              { key: 'e-a-end', source: 'approval_a', target: 'end' },
            ],
          }

    const templateId = await publishGraphTemplate(adminToken, graph as ReturnType<typeof oneNodeGraph>, label)
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    if (shape === 'two_nodes') {
      const first = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(first.status, await first.clone().text()).toBe(200)
      if (approveVia === 'mixed') {
        const versionRow = await pool().query<{ version: number }>(
          `SELECT version FROM approval_instances WHERE id = $1`,
          [documentId],
        )
        const legacy = await jsonRequest(baseUrl, `/api/approvals/${documentId}/approve`, tokenD, {
          method: 'POST',
          body: { version: versionRow.rows[0].version },
        })
        expect(legacy.status, await legacy.clone().text()).toBe(200)
      } else {
        const second = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(second.status, await second.clone().text()).toBe(200)
      }
    } else {
      const byD = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(byD.status, await byD.clone().text()).toBe(200)
      if (shape === 'cosign_mixed') {
        const byC = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenC, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(byC.status, await byC.clone().text()).toBe(200)
      }
    }

    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status, 'the ORIGINAL must be genuinely approved before any cancel round').toBe('approved')
    return {
      documentId,
      requesterId,
      delegators: delegatorsOfD,
      ownApprover: shape === 'cosign_mixed' ? thirdPerson : null,
      delegateeD,
    }
  }

  it('§2-G3 第三句 正控 P16(a) — 多人委托同一人(A→D、B→D,两节点都走模板运行时):两席**各自**还原回 A 和 B,D 不占席位、不重复,会签人数仍是 2', async () => {
    const fixture = await multiDelegatorOriginal('g3dlg-multi2', 'two_nodes', 'actions')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    expect(attempt.thrown, 'both rows carry a nodeKey and map to exactly one delegator each ⇒ resolvable').toBeFalsy()
    // `wi4-mdlA-…` < `wi4-mdlB-…`,ORDER BY 固定顺序,无需在这里再排。
    expect(attempt.seats).toEqual([fixture.delegators[0], fixture.delegators[1]])
    expect(attempt.seats).not.toContain(fixture.delegateeD)
    // 明写成计数:「一个人替两个人批」折成一席,就是会签门槛被悄悄减半 —— 正是本节要防的那一格。
    expect(attempt.seats.length).toBe(2)
    expect(new Set(attempt.seats).size, 'no duplicate seat for the same subject').toBe(2)
  })

  it('§2-G3 第三句 负控 N9(a) — owner 点名的反例:多人委托同一人 × legacy 行(A→D、B→D,节点 2 走 legacy 路由)⇒ 该行有两个候选原主体,**阻断**(seat_unresolvable),既不猜 A/B 也不回退 D', async () => {
    const fixture = await multiDelegatorOriginal('g3dlg-multiL', 'two_nodes', 'mixed')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    // 裁决前实测的答案是 `[A, D]`(节点 1 还原成 A、节点 2 的 legacy 行把 D 留下)—— 恰好是
    // 「静默回退给历史被委托人」。现在这一行不可归属 ⇒ 整张单据阻断。
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['seat_unresolvable'] }, [
      ...fixture.delegators,
      fixture.delegateeD,
    ])
    expect(attempt.seats).toEqual([])
  })

  it('§2-G3 第三句 负控 N10(a) — 多人委托同一人 × 原主体 A 已停权 ⇒ 阻断(reasons: [inactive]),**不**回退给 D;另一位原主体 B 仍在职也救不了这张单据(阻断不过滤)', async () => {
    const fixture = await multiDelegatorOriginal('g3dlg-multiX', 'two_nodes', 'actions')
    const deactivated = await pool().query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [fixture.delegators[0]])
    expect(deactivated.rowCount).toBe(1)
    const stillInactive = await pool().query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [
      fixture.delegators[0],
    ])
    expect(stillInactive.rows[0]?.is_active).toBe(false)
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    // `ineligibleCount: 1` 而不是 2:B 仍然合格。数到 2 说明还原把两席都指向了同一个人。
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['inactive'] }, [
      ...fixture.delegators,
      fixture.delegateeD,
    ])
    expect(attempt.seats).toEqual([])
  })

  it('§2-G3 第三句 正控 P17(a) — 三人委托同一人的**会签**场景:席位数是今天实测的 1(解析器在建单时就把三席折成一席,只留第一位委托人的 provenance),不是 3;折叠发生在 pushResolved,不在还原', async () => {
    const fixture = await multiDelegatorOriginal('g3dlg-cosign3', 'cosign_all_delegated', 'actions')
    // 先把**折叠本身**测成数据,而不是从席位数倒推:原单上只剩一条 user assignment。
    const originalSeats = await pool().query<{ assignee_id: string; delegated_from: string | null }>(
      `SELECT assignee_id, metadata->>'delegatedFrom' AS delegated_from
         FROM approval_assignments WHERE instance_id = $1 AND assignment_type = 'user' ORDER BY assignee_id`,
      [fixture.documentId],
    )
    expect(originalSeats.rows).toEqual([{ assignee_id: fixture.delegateeD, delegated_from: fixture.delegators[0] }])

    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    expect(attempt.thrown).toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegators[0]])
    expect(attempt.seats.length).toBe(1)
    expect(attempt.seats).not.toContain(fixture.delegateeD)
    // 这一腿**不主张**「1 是对的」。它把一条本轮无法修的事实钉成数据:B、C 的席位在建单那一刻
    // 就不存在了,审计轨迹里没有任何东西能让撤销轮还原出他们 —— 所以这不是 `seat_unresolvable`
    // (没有两个候选,只有一个),阻断谓词对它零判别力。登记在设计 MD §3.4,属 owner。
  })

  it('§2-G3 第三句 正控 P18(a) — 会签节点上「两人委托同一人 + 第三人自己批」:席位是 {A, C} 两人(A 由还原得到、C 是本人),D 不在里面;B 的席位在建单时已被折掉', async () => {
    const fixture = await multiDelegatorOriginal('g3dlg-cosignM', 'cosign_mixed', 'actions')
    expect(fixture.ownApprover).toBeTruthy()
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    expect(attempt.thrown).toBeFalsy()
    // 两条 approve 行同节点、同 nodeKey:D 的那条有 `delegatedFrom = A` ⇒ 还原成 A;
    // C 的那条没有 ⇒ 保持 C。这是「同一节点内 delegated 与 own 两种席位并存」的唯一一腿。
    expect(attempt.seats).toEqual([fixture.delegators[0], fixture.ownApprover as string].sort())
    expect(attempt.seats).not.toContain(fixture.delegateeD)
    expect(attempt.seats).not.toContain(fixture.delegators[1])
    expect(attempt.seats.length).toBe(2)
  })

  it('§2-G3 第三句 正控 P19(a)(爆炸半径闸门)— legacy 语料但**从来没有过委托**:席位是本人 A、201 照常创建。阻断只针对「无法归属的被委托行」,不是「所有无 nodeKey 的行」', async () => {
    const suffix = `g3dlg-lgcyplain-${TS}`
    const requesterId = `wi4-preq-${suffix}`
    const approverA = `wi4-papr-${suffix}`
    const adminId = `wi4-padm-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const tokenA = await authToken(baseUrl, approverA)
    const templateId = await publishOneNodeTemplate(adminToken, approverA, 'lgcyplain')
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)
    const versionRow = await pool().query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`,
      [documentId],
    )
    const legacy = await jsonRequest(baseUrl, `/api/approvals/${documentId}/approve`, tokenA, {
      method: 'POST',
      body: { version: versionRow.rows[0].version },
    })
    expect(legacy.status, await legacy.clone().text()).toBe(200)
    // 这一腿的前提,断言而不是假设:approve 行确实**没有** nodeKey(否则它测的就不是 legacy 语料),
    // 且这张单据上确实**没有**任何带 `delegatedFrom` 的席位。
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve'`,
      [documentId],
    )
    expect(records.rows).toEqual([{ actor_id: approverA, node_key: null }])
    const delegatedRows = await pool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM approval_assignments
        WHERE instance_id = $1 AND metadata->>'delegatedFrom' IS NOT NULL`,
      [documentId],
    )
    expect(delegatedRows.rows[0].count).toBe('0')

    const attempt = await attemptCancelRound(documentId, requesterId)
    expect(attempt.thrown, 'the whole pre-delegation legacy corpus must stay cancellable').toBeFalsy()
    expect(attempt.seats).toEqual([approverA])
  })

  // ── CORROBORATION:`metadata.nodeKey` 是请求体来的,不能当系统写的用 ───────────────────────────
  //
  // **这一组是审阅意见揪出来的、我第一版漏掉的洞,实测复现过才修的。** 第一版把「行有 `nodeKey`」当成
  // 「这条 approve 行属于某个节点席位」的充分条件,于是**上面整组阻断可以用一个垃圾字符串绕过去**:
  // legacy `POST /:id/approve` 把请求体的 `metadata` 逐字写进 `approval_records.metadata`,
  // 任何持 `approvals:act` 的主体发 `{"metadata":{"nodeKey":"totally_made_up_node"}}`,
  // join 落到一个不存在的节点、`node_delegators` 为空、代码就把 actor 坐下了 ——
  // **实测(修复前,真库):席位 = `[D]`,零阻断**,即裁决点名禁止的那个回退,只是多打了 8 个字。
  //
  // 修法不是「过滤掉没见过的 nodeKey」,而是**换判据**:先问 actor 在**本实例**上有没有过被委托席位;
  // 有,才要求这行的 `nodeKey` **恰好命中该 actor 自己的一条 assignment 行**(委托的或自己的都算)。
  // 命中 0 条 ⇒ 名字没有凭据 ⇒ `seat_unresolvable`;命中 >1 条 ⇒ 歧义 ⇒ 同。
  // 没有被委托席位的 actor 完全不受影响(`P19(a)`)—— 爆炸半径就锁在这里。
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it('§2-G3 第三句 负控 N11(a)(审阅发现,修复前实测可绕过)— legacy 路由伪造 metadata.nodeKey 成一个**不存在的节点**:不再把 actor 坐下,而是 409 seat_unresolvable、零行', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-forged', {
      approveVia: 'legacy',
      legacyNodeKey: 'totally_made_up_node_that_never_existed',
    })
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    // 修复前这里 MEASURED 的答案是:不抛、席位 `[D]`。现在:
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
    ])
    expect(attempt.seats).toEqual([])
  })

  it('§2-G3 第三句 正控 P20(a) — 反向不对称:同一条 legacy 路由,传**真实的** nodeKey(approval_a)不是绕过,它只是把还原做对了 ⇒ 201、席位 [A];所以修法拒的是「没有凭据的名字」,不是「请求体里带了 metadata」', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-truthy', {
      approveVia: 'legacy',
      legacyNodeKey: 'approval_a',
    })
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    expect(attempt.thrown).toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegatorA])
    expect(attempt.seats).not.toContain(fixture.delegateeD)
    // 这一腿与 N11(a) 只差 `legacyNodeKey` 一个字段的值,所以它把 N11(a) 的红归因到**凭据**,
    // 而不是归因到「legacy + metadata 一律拒」。少了它,N11(a) 可能只是在测一条更粗的规则。
  })

  it('§2-G3 第三句 负控 P21(a)(**已登记的残留**,钉今天的答案)— 被委托人在自己**真有**席位的兄弟节点上走 legacy、却把 nodeKey 报成**被委托的那个节点**:凭据判据命中 1 条、放行,于是他把自己从撤销轮里摘了出去,会签人数 2 → 1', async () => {
    const fixture = await delegatedSiblingSeatOriginal('g3dlg-selfdrop', {
      secondNodeVia: 'legacy',
      legacyNodeKey: 'approval_a',
    })
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    // MEASURED,不是预测。两条 approve 行都被归属到 approval_a ⇒ 都还原成 A ⇒ 去重后 1 席。
    expect(attempt.thrown).toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegatorA])
    expect(attempt.seats.length).toBe(1)
    // **这条腿不主张 1 是对的。** 诚实的同形单据(`P11(a)`,两节点都走模板运行时)答 {A, D} 两席;
    // 这里 D 通过给自己那条 legacy 行改名,把自己从撤销轮的会签集合里摘掉了 —— 门槛真的降了。
    // 为什么本轮不修:凭据判据在这条路径上**没有被骗**(D 确实在 approval_a 有一条被委托席位),
    // 要分辨「这条 legacy 行到底结的是哪个节点」需要的是 legacy 路由自己写 `nodeKey`,
    // 或者按「actor 的席位数 vs approve 行数」对账 —— 前者是路由的合同变更,后者会误伤诚实语料。
    // 两条都属 owner,已登记进设计 MD §3.4。将来若被修好,这条腿会红并点名自己。
  })

  /**
   * 正控 `P22(a)` / 负控 `N13(a)` 的共同夹具:一个**既是别人的代理、又自己决定别的节点**的人。
   *
   * `siblingNode: 'role'` —— `approval_role` 是 `assigneeType: 'role'`,席位行是 `(type='role',
   * assignee_id='admin')`,**没有任何一行 `assignee_id = D`**;`approval_user` 是 A 的席位、被委托替换成 D。
   * D 两个节点都亲自按,**全程 `/actions`,不碰 legacy 路由**。这是 `P22(a)`。
   *
   * `siblingNode: 'otherUser'` —— `approval_b` 是**第三人 E** 的 user 席位。D 在 `approval_a` 是 A 的代理,
   * 然后走 **legacy** 路由把整单批掉、并把 `nodeKey` 报成 `approval_b`(E 的节点)。这是 `N13(a)`:
   * 「凭据」不能是「这个节点在本单上存在」,否则指着别人的节点就能脱身。
   */
  async function delegateAlsoDecidesSiblingNode(
    label: string,
    siblingNode: 'role' | 'otherUser',
    // Gate round 3 P1: whether D's membership of the ROLE the sibling node names exists as a
    // SERVER-WRITTEN record. `true` is the production shape (正控 `P22(a)`); `false` keeps the
    // pre-credential fixture shape and pins what it now costs (负控 `N16(a)`).
    options: { seedRoleMembership?: boolean } = {},
  ): Promise<{ documentId: string; requesterId: string; delegatorA: string; delegateeD: string; otherUserE: string }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-xreq-${suffix}`
    const delegatorA = `wi4-xdlA-${suffix}`
    const delegateeD = `wi4-xdlD-${suffix}`
    const otherUserE = `wi4-xothE-${suffix}`
    const adminId = `wi4-xadm-${suffix}`
    const delegationId = `wi4-xdeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    await authToken(baseUrl, otherUserE)
    const tokenD = await authToken(baseUrl, delegateeD)
    if (siblingNode === 'role' && options.seedRoleMembership === true) {
      await grantRoleMembership(delegateeD, 'admin')
    }

    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )

    const siblingKey = siblingNode === 'role' ? 'approval_role' : 'approval_b'
    const siblingConfig =
      siblingNode === 'role'
        ? // `roles=admin` is on every token this file mints, and `assignmentMatchesActor` matches a
          // ROLE seat on `actorRoles.includes(assignee_id)` — the same legacy shape `P15(a)` uses.
          { assigneeType: 'role', assigneeIds: ['admin'], approvalMode: 'single' }
        : { assigneeType: 'user', assigneeIds: [otherUserE], approvalMode: 'single' }

    const templateId = await publishGraphTemplate(
      adminToken,
      {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_a',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [delegatorA], approvalMode: 'single' },
          },
          { key: siblingKey, type: 'approval', config: siblingConfig },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-x', source: 'approval_a', target: siblingKey },
          { key: 'e-x-end', source: siblingKey, target: 'end' },
        ],
      } as unknown as ReturnType<typeof oneNodeGraph>,
      label,
    )

    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    const first = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(first.status, `approval_a: ${await first.clone().text()}`).toBe(200)

    if (siblingNode === 'role') {
      const second = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(second.status, `approval_role: ${await second.clone().text()}`).toBe(200)
    } else {
      // D is NOT the seat holder at `approval_b`. The legacy route does not consult seats at all —
      // it locks any pending `platform` instance by id — which is precisely why the `nodeKey` it
      // copies out of the body cannot be taken as evidence of anything.
      const versionRow = await pool().query<{ version: number }>(
        `SELECT version FROM approval_instances WHERE id = $1`,
        [documentId],
      )
      const legacy = await jsonRequest(baseUrl, `/api/approvals/${documentId}/approve`, tokenD, {
        method: 'POST',
        body: { version: versionRow.rows[0].version, metadata: { nodeKey: 'approval_b' } },
      })
      expect(legacy.status, `legacy: ${await legacy.clone().text()}`).toBe(200)
    }

    // 正控先行,逐条:两个节点的席位形状必须是这条腿说的那样,否则断言可以因为别的原因平凡成立。
    const seats = await pool().query<{ node_key: string | null; assignment_type: string; assignee_id: string; df: string | null }>(
      `SELECT node_key, assignment_type, assignee_id, metadata->>'delegatedFrom' AS df
         FROM approval_assignments WHERE instance_id = $1 ORDER BY node_key`,
      [documentId],
    )
    expect(seats.rows).toEqual(
      siblingNode === 'role'
        ? [
            { node_key: 'approval_a', assignment_type: 'user', assignee_id: delegateeD, df: delegatorA },
            { node_key: 'approval_role', assignment_type: 'role', assignee_id: 'admin', df: null },
          ]
        : [
            { node_key: 'approval_a', assignment_type: 'user', assignee_id: delegateeD, df: delegatorA },
            { node_key: 'approval_b', assignment_type: 'user', assignee_id: otherUserE, df: null },
          ],
    )
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY id`,
      [documentId],
    )
    // 两条 approve 行都由 D 写、都带一个**真实存在于本单**的 nodeKey —— 两条腿的差别只在那个节点
    // 是不是 D 自己够得着的席位。
    expect(records.rows).toEqual([
      { actor_id: delegateeD, node_key: 'approval_a' },
      { actor_id: delegateeD, node_key: siblingKey },
    ])
    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')
    return { documentId, requesterId, delegatorA, delegateeD, otherUserE }
  }

  it('§2-G3 第三句 正控 P22(a)(凭据修法的**反向**闸门,第二次自我推翻的见证)— 同一个人「在角色节点亲自决定」+「在 user 节点是 A 的代理」,**全程 /actions、不碰 legacy**:席位是 {A, D} 两人、201。凭据判据不得把这种诚实单据判成永久不可撤销', async () => {
    const fixture = await delegateAlsoDecidesSiblingNode('g3dlg-rolesib', 'role', { seedRoleMembership: true })
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    // 凭据修法的**第一版**在这里 MEASURED 为 409 `seat_unresolvable`、零行 —— 一张完全诚实的单据变成
    // 永久开不出撤销轮。根因:角色节点的席位行 `assignee_id` 是**角色**不是人,所以「nodeKey 必须命中
    // 该 actor 自己的 user 行」对它恒为假。委托替换只动 `assignmentType === 'user'` 的席位
    // (`ApprovalAssigneeResolver.pushResolved`),所以非 user 席位**没有东西可还原**,也就不构成脱身路径。
    expect(attempt.thrown, 'an honest /actions-only document must stay cancellable').toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegatorA, fixture.delegateeD])
    expect(attempt.seats.length).toBe(2)
    // 门槛的正向见证:诚实单据是 **2 席**。负控 `N14(a)` / `N15(a)` 的「不得 2→1」只有对着这一句才有
    // 意义 —— 阻断态的 `seats` 恒为 `[]`,单看阻断腿证不了门槛没被降。
    // 凭据修法之后这条腿多了一个前置条件:D 的 admin 成员身份必须是**服务端记录**
    // (`seedRoleMembership: true` 写进 `user_roles`),不能只是 dev-token 里的 `roles=admin`。
    // 少了那条记录,同一张单据现在阻断 —— 那是 `N16(a)`,严格性的代价被钉成数据而不是散文。
  })

  it('§2-G3 第三句 负控 N13(a) — 放宽不等于放开:D 走 legacy 把 nodeKey 报成**第三人 E 的 user 节点**(该节点在本单上确实存在)⇒ 仍然 409 seat_unresolvable、零行。凭据不是「这个节点存在」,是「这个 actor 在那里真有席位」', async () => {
    const fixture = await delegateAlsoDecidesSiblingNode('g3dlg-othersib', 'otherUser')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
      fixture.otherUserE,
    ])
    expect(attempt.seats).toEqual([])
    // 这条腿与 P22(a) 只差**兄弟节点的席位类型**(role vs 另一个人的 user)。少了它,P22(a) 的放宽
    // 可能只是「有第二个节点就放行」;有了它,放宽被钉死在「非 user 席位才放行」这一格上。
  })

  it('§2-G3 第三句 负控 N16(a)(严格性的代价,钉成数据)— 与 P22(a) **逐字段同形**的诚实单据,唯一差别是 D 的角色成员身份**没有服务端记录**(只存在于 dev-token 的 roles=admin 里)⇒ 409 seat_unresolvable、零行。凭据读的是持久化底座,不是令牌声明', async () => {
    const fixture = await delegateAlsoDecidesSiblingNode('g3dlg-rolesib-nomem', 'role', { seedRoleMembership: false })
    // 前置正控:库里确实**没有**这条成员记录(否则这条腿会因为别的原因平凡阻断/放行)。
    const membership = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_roles WHERE user_id = $1`,
      [fixture.delegateeD],
    )
    expect(membership.rows[0]?.n).toBe('0')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
      fixture.otherUserE,
    ])
    expect(attempt.seats).toEqual([])
    // **这条腿不主张阻断在产品意义上是「对」的。** 它钉的是修法的代价:凭据读 `user_roles`/`users.role`,
    // 而**决定时刻**的成员身份本仓今天不持久化 —— 所以「当时在角色里、现在不在」与「从来不在」在库里
    // 同形,两者都按 fail-closed 阻断(裁决:「原主体无法可靠还原…则阻断」)。owner 若要放宽,
    // 要么给角色成员身份留决定时刻快照,要么让 legacy 路由自己写 `nodeKey`(设计 MD §3.4 已登记)。
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 门审第 3 轮 P1 —— 非 user 席位臂必须有**服务端凭据**(owner 2026-09-20 裁决的直接落地)
  //
  // 上一版这一臂的放行条件是「该节点带一条非 user 席位」,一个**没有 actor 项**的谓词:它是关于
  // **节点**的事实,而节点名字来自请求体。门审在真库上造了两个变体把它打穿(A 丢席、会签 2→1、
  // 零阻断)。下面两条负控就是那两个变体,各自钉住凭据的一半,并各配一条**诚实兄弟腿**作为门槛见证 ——
  // 阻断态的 `seats` 恒为 `[]`,「A 不丢 / 门槛不降」只能对着诚实腿的 `[A, X]` 两席来读。
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * `start → approval_role → approval_a → end` + 委托 A→D(全程真实路由建单/批准)。
   *
   * 角色节点在**前**、A 的 user 节点在**后**,所以第二条 approve 行是 D 以 **A 的代理**身份结的 ——
   * 正是裁决点名要还原回 A 的那一席。两个旋钮:
   *   · `roleApprover` —— 角色节点由谁走 `/actions` 亲自按(D 自己,或**第三人 E**);
   *   · `secondRow` —— 第二个节点怎么结:`'honest'` 走 `/actions`(行带真实 `nodeKey='approval_a'`),
   *     `'forged'` 走 **legacy** `POST /:id/approve` 并把 `metadata.nodeKey` 报成**角色节点**。
   *   · `roleAssigneeIds` —— 角色节点的席位行数。两条 role id 会落**两行**席位。在**旧**实现里这是
   *     「预算」富余的来源(`N15(a)` 用它隔离成员身份那一半);在门审第 4 轮它被证明是 P1 的载体
   *     (FORGERY3 / FORGERY4),所以本轮的凭据不再看节点预算,只看**这个 actor** 够得着的席位数。
   *   · `membershipFor` —— 谁在库里有哪个角色的成员记录。`roleId` 省略时取 `roleAssigneeIds[0]`;
   *     FORGERY3 需要把被委托人放进**另一条** role id(`auditor`),所以这个旋钮按 (who, roleId) 对
   *     取值,而不是只按人取值。
   */
  async function roleNodeFirstOriginal(
    label: string,
    opts: {
      roleApprover: 'delegateeD' | 'otherUserE'
      // `'thirdPartyLegacy'` —— 第三人 E(**没有**任何委托)走 legacy 把 `nodeKey` 报成 A 的节点。
      // 它把 A 的节点「点亮」成有决定记录,于是结算合取(3)被满足 —— 这是本轮修法**新造**的残留,
      // 由 `P27(a)` 钉成数据。
      secondRow: 'honest' | 'forged' | 'thirdPartyLegacy'
      roleAssigneeIds?: string[]
      membershipFor?: Array<{ who: 'delegateeD' | 'otherUserE'; roleId?: string }>
    },
  ): Promise<{
    documentId: string
    requesterId: string
    delegatorA: string
    delegateeD: string
    otherUserE: string
    roleSeatRows: number
  }> {
    const roleAssigneeIds = opts.roleAssigneeIds ?? ['admin']
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-rnreq-${suffix}`
    const delegatorA = `wi4-rnA-${suffix}`
    const delegateeD = `wi4-rnD-${suffix}`
    const otherUserE = `wi4-rnE-${suffix}`
    const adminId = `wi4-rnadm-${suffix}`
    const delegationId = `wi4-rndeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)
    const tokenE = await authToken(baseUrl, otherUserE)
    for (const grant of opts.membershipFor ?? []) {
      await grantRoleMembership(
        grant.who === 'delegateeD' ? delegateeD : otherUserE,
        grant.roleId ?? roleAssigneeIds[0],
      )
    }

    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )

    const templateId = await publishGraphTemplate(
      adminToken,
      {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_role',
            type: 'approval',
            config: { assigneeType: 'role', assigneeIds: roleAssigneeIds, approvalMode: 'single' },
          },
          {
            key: 'approval_a',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [delegatorA], approvalMode: 'single' },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-r', source: 'start', target: 'approval_role' },
          { key: 'e-r-a', source: 'approval_role', target: 'approval_a' },
          { key: 'e-a-end', source: 'approval_a', target: 'end' },
        ],
      } as unknown as ReturnType<typeof oneNodeGraph>,
      label,
    )

    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    const roleToken = opts.roleApprover === 'delegateeD' ? tokenD : tokenE
    const first = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, roleToken, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(first.status, `approval_role: ${await first.clone().text()}`).toBe(200)

    if (opts.secondRow === 'honest') {
      const second = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(second.status, `approval_a: ${await second.clone().text()}`).toBe(200)
    } else {
      const versionRow = await pool().query<{ version: number }>(
        `SELECT version FROM approval_instances WHERE id = $1`,
        [documentId],
      )
      // 伪造只用到 shipped 路由的既有行为:legacy `POST /:id/approve` 不查席位,并把请求体的
      // `metadata` 原样写进 `approval_records.metadata`。这里**没有**手工改表。
      const forger = opts.secondRow === 'thirdPartyLegacy' ? tokenE : tokenD
      const forgedNodeKey = opts.secondRow === 'thirdPartyLegacy' ? 'approval_a' : 'approval_role'
      const legacy = await jsonRequest(baseUrl, `/api/approvals/${documentId}/approve`, forger, {
        method: 'POST',
        body: { version: versionRow.rows[0].version, metadata: { nodeKey: forgedNodeKey } },
      })
      expect(legacy.status, `legacy: ${await legacy.clone().text()}`).toBe(200)
    }

    // 正控先行:席位与 approve 行的形状必须是这条腿说的那样。
    const seats = await pool().query<{ node_key: string | null; assignment_type: string; assignee_id: string; df: string | null }>(
      `SELECT node_key, assignment_type, assignee_id, metadata->>'delegatedFrom' AS df
         FROM approval_assignments WHERE instance_id = $1 ORDER BY node_key, assignee_id`,
      [documentId],
    )
    const roleSeatRows = seats.rows.filter((row) => row.node_key === 'approval_role').length
    expect(roleSeatRows).toBe(roleAssigneeIds.length)
    // 裁决点名的那一席**在原单上原样健在** —— 阻断腿断言的是「撤销轮没开成」,这一句断言的是
    // 「A 的席位没有被伪造行改写掉」,两者不是同一件事。
    expect(seats.rows.filter((row) => row.node_key === 'approval_a')).toEqual([
      { node_key: 'approval_a', assignment_type: 'user', assignee_id: delegateeD, df: delegatorA },
    ])
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY id`,
      [documentId],
    )
    expect(records.rows).toEqual([
      { actor_id: opts.roleApprover === 'delegateeD' ? delegateeD : otherUserE, node_key: 'approval_role' },
      opts.secondRow === 'thirdPartyLegacy'
        ? { actor_id: otherUserE, node_key: 'approval_a' }
        : { actor_id: delegateeD, node_key: opts.secondRow === 'honest' ? 'approval_a' : 'approval_role' },
    ])
    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')
    return { documentId, requesterId, delegatorA, delegateeD, otherUserE, roleSeatRows }
  }

  it('§2-G3 第三句 正控 P23(a)(N14(a) 的诚实兄弟腿 / 门槛见证)— 角色节点在前、A 的 user 节点在后,两条行都诚实(D 有服务端角色成员记录、第二条走 /actions):席位是 {A, D} **两席**', async () => {
    const fixture = await roleNodeFirstOriginal('g3cred-honest', {
      roleApprover: 'delegateeD',
      secondRow: 'honest',
      membershipFor: [{ who: 'delegateeD' }],
    })
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    expect(attempt.thrown, 'an honest document must stay cancellable').toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegatorA, fixture.delegateeD])
    expect(attempt.seats.length).toBe(2)
  })

  it('§2-G3 第三句 负控 N14(a)(门审 FORGERY,基数那一半)— D 是**真**角色成员,但把自己那条 legacy 行的 nodeKey 也报成角色节点:两条 approve 行压在**一席**的节点上 ⇒ 409 seat_unresolvable、零行;A 在原单上的席位原样健在,会签门槛不会从 2 降到 1', async () => {
    const fixture = await roleNodeFirstOriginal('g3cred-forgery', {
      roleApprover: 'delegateeD',
      secondRow: 'forged',
      membershipFor: [{ who: 'delegateeD' }],
    })
    // 隔离前置:成员身份那一半在这条腿上**成立**(库里有记录)。
    // **门审第 4 轮后的诚实分界**:这条腿现在是**过定**的 —— 占位容量合取(D 两条行压在他够得着的
    // 一席上)与结算合取(A 的节点一条决定记录都没有)**同时**把它判死。它因此**不是**任一合取的
    // 隔离见证:容量那一半的隔离腿是 `N20(a)`,结算那一半的是 `N19(a)`。这里写「过定」而不是
    // 「隔离」,是因为 mutation 网格实测两条都红不动它。
    const membership = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
      [fixture.delegateeD],
    )
    expect(membership.rows[0]?.n).toBe('1')
    expect(fixture.roleSeatRows).toBe(1)
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    await expectSeatBlock(attempt, { ineligibleCount: 2, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
      fixture.otherUserE,
    ])
    expect(attempt.seats).toEqual([])
    // 「A 不丢」的可断言形式,两句分开:①撤销轮没开成(上面);②原单上 A 的那条委托席位行没被改写
    // (夹具里的 `approval_a` 行断言);③诚实兄弟腿 `P23(a)` 答 `[A, D]` 两席 —— 没有 ③,
    // 「门槛不得 2→1」就没有可比的参照物。
  })

  it('§2-G3 第三句 正控 P24(a)(N15(a) 的诚实兄弟腿)— 角色节点由**第三人 E** 亲自按、D 诚实地结掉 A 的节点:席位是 {A, E} 两席,D 不占席位', async () => {
    const fixture = await roleNodeFirstOriginal('g3cred-third-honest', {
      roleApprover: 'otherUserE',
      secondRow: 'honest',
      roleAssigneeIds: ['admin', 'auditor'],
      membershipFor: [{ who: 'otherUserE' }],
    })
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    expect(attempt.thrown, 'an honest document must stay cancellable').toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegatorA, fixture.otherUserE].sort())
    expect(attempt.seats.length).toBe(2)
    expect(attempt.seats).not.toContain(fixture.delegateeD)
  })

  it('§2-G3 第三句 负控 N15(a)(门审 FORGERY2,成员身份那一半,**隔离**)— 角色节点由第三人 E 决定、D **不在**任何一个角色里,只是把节点名字说了出来;角色节点有**两行**席位所以基数预算有富余 ⇒ 仍然 409 seat_unresolvable、零行。凭据不是「这个节点带角色席位」,是「这个 actor 在那个角色里」', async () => {
    const fixture = await roleNodeFirstOriginal('g3cred-forgery2', {
      roleApprover: 'otherUserE',
      secondRow: 'forged',
      roleAssigneeIds: ['admin', 'auditor'],
      membershipFor: [{ who: 'otherUserE' }],
    })
    // 隔离前置,两条:① 角色节点有 2 行席位、节点上有 2 条 approve 行 —— 在**旧**实现里这意味着
    // 「基数预算那一半通过」;门审第 4 轮证明那正是 P1 的载体,本轮已换成**按 actor 的占位容量**,
    // 而 D 在这条腿上够得着的席位数是 **0**(他不在任何角色里),所以容量那一半也不再是独立的;
    // ② D 在库里没有任何角色成员记录。**过定**:成员身份与结算两条合取同时判死这条腿,
    // 隔离见证分别是 `N16(a)`(成员身份)与 `N19(a)`(结算)。
    expect(fixture.roleSeatRows).toBe(2)
    const approveRowsAtRoleNode = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_records
        WHERE instance_id = $1 AND action = 'approve' AND metadata->>'nodeKey' = 'approval_role'`,
      [fixture.documentId],
    )
    expect(approveRowsAtRoleNode.rows[0]?.n).toBe('2')
    const membership = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_roles WHERE user_id = $1`,
      [fixture.delegateeD],
    )
    expect(membership.rows[0]?.n).toBe('0')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
      fixture.otherUserE,
    ])
    expect(attempt.seats).toEqual([])
    // 这条腿直接证伪了上一版实现里那句承重注释(「the actor decided it through that seat」):
    // D 既不是角色成员、也从没决定过那个节点。诚实兄弟腿 `P24(a)` 答 `[A, E]` 两席 —— 伪造要拿走的
    // 正是 A 那一席。
    //
    // **已登记的残留(不在本轮修,写出来而不是装作不存在)**:预算富余是真的 —— 若伪造者**恰好**
    // 是 `auditor` 的成员,两半凭据都会通过。要分辨「这一行结的是哪一席」需要 legacy 路由自己写
    // `nodeKey`(设计 MD §3.4 的 owner 项),本臂的两半都做不到。
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 门审第 4 轮 P1 —— 凭据从 **capability(预算)** 换成 **occupancy(占位)**(候选方案 (b),owner 未裁)
  //
  // 上一版的两半是「这个 actor **能不能**在那里有席位」(成员身份)+「这个**节点**的行数装不装得下」
  // (预算)。门审在真库上证明预算是**总量**:一个配了两条 role id 的或签角色节点落 2 行席位、只需
  // 1 条 approve 行,于是**恒有一格富余**,FORGERY3 / FORGERY4 把第 3 轮 P1 的读数一字不差地复现
  // (A 丢席、会签 2 → 1、零阻断)。本轮把预算换成**按 actor 的占位容量**,并补上第三条合取
  // 「结算」—— 前两条都是关于**伪造者**的事实,没有一条会注意到**原审批主体的席位不见了**。
  //
  // 三条合取,三条**隔离**腿,各自可被单点 mutation 打红:
  //   · 成员身份 → `N16(a)`(同形诚实单据,唯一差别是库里没有成员记录);
  //   · 占位容量 → `N20(a)`(诚实结掉委托节点 + 亲自决定角色节点,再**多发一条** legacy 行报同一个
  //     角色节点:成员身份与结算都成立,只有容量判死它);
  //   · 结算     → `N19(a)`(= 门审 FORGERY3:第三人诚实决定角色节点,被委托人是**另一条** role id
  //     的真成员、只把节点名字说出来;成员身份与容量都成立,只有结算判死它)。
  // 诚实兄弟腿(门槛见证,阻断态 `seats` 恒为 `[]`,「A 不丢 / 门槛不降」只能对着它们读):
  //   `P25(a)`(两条 role id 的诚实 `[A, D]`)、`P26(a)`(三节点诚实 `[A, D, E]`)、`P24(a)`(`[A, E]`)。
  // **新残留,带腿不带散文**:结算合取取的是**弱**形式(「那个节点有**某条**决定记录」),所以第三人
  // 的一条 legacy 行就能把它点亮 —— `P27(a)` 钉今天的答案(`[D, E]`,A 丢)。根治仍是 (c)。
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it('§2-G3 第三句 正控 P25(a)(门审 HONEST4 / `N18(a)` 的诚实兄弟腿)— 角色节点配**两条** role id、由 D 亲自按(他是其中一条的真成员),D 再诚实地结掉 A 的节点:席位是 {A, D} **两席**。预算富余不再是凭据,但诚实单据照样开得出撤销轮', async () => {
    const fixture = await roleNodeFirstOriginal('g3cred-honest4', {
      roleApprover: 'delegateeD',
      secondRow: 'honest',
      roleAssigneeIds: ['admin', 'auditor'],
      membershipFor: [{ who: 'delegateeD' }],
    })
    // 前置正控:富余确实存在(2 行席位),所以这条腿不是靠「没有富余」平凡通过的。
    expect(fixture.roleSeatRows).toBe(2)
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    expect(attempt.thrown, 'an honest document must stay cancellable').toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegatorA, fixture.delegateeD])
    expect(attempt.seats.length).toBe(2)
  })

  it('§2-G3 第三句 负控 N18(a)(门审第 4 轮 FORGERY4,**承重**)— 或签角色节点配两条 role id(2 席 / 1 条诚实 approve 行,预算恒有一格富余):D 是其中一条的真成员,把自己那条 legacy 行的 nodeKey 也报成角色节点 ⇒ 409 seat_unresolvable、零行。修复前实测 `seats=[D]`、A 完全丢失、会签门槛 2 → 1、零阻断', async () => {
    const fixture = await roleNodeFirstOriginal('g3cred-forgery4', {
      roleApprover: 'delegateeD',
      secondRow: 'forged',
      roleAssigneeIds: ['admin', 'auditor'],
      membershipFor: [{ who: 'delegateeD' }],
    })
    // 前置正控三条,把「为什么修复前它能穿过去」钉成数据而不是引用门审报告:
    // ① 节点有 2 行席位;② 节点上有 2 条 approve 行 ⇒ **旧预算判据 2 ≤ 2 成立**;
    // ③ D 的成员身份有服务端记录 ⇒ 成员身份那一半也成立。两半都过,这就是门审的 FORGERY4。
    expect(fixture.roleSeatRows).toBe(2)
    const approveRowsAtRoleNode = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_records
        WHERE instance_id = $1 AND action = 'approve' AND metadata->>'nodeKey' = 'approval_role'`,
      [fixture.documentId],
    )
    expect(approveRowsAtRoleNode.rows[0]?.n).toBe('2')
    const membership = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
      [fixture.delegateeD],
    )
    expect(membership.rows[0]?.n).toBe('1')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    await expectSeatBlock(attempt, { ineligibleCount: 2, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
      fixture.otherUserE,
    ])
    expect(attempt.seats).toEqual([])
    // 「A 不丢」三句分开写(与 `N14(a)` 同一形状):①撤销轮没开成(上面);②原单上 A 的那条委托
    // 席位行没被改写(夹具内断言);③诚实兄弟腿 `P25(a)` 答 `[A, D]` **两席**,这就是门槛参照物。
    // **过定**:容量合取与结算合取都判死它,隔离见证分别是 `N20(a)` / `N19(a)`。
  })

  it('§2-G3 第三句 负控 N19(a)(门审第 4 轮 FORGERY3;**结算合取的隔离见证**)— 角色节点由第三人 E 诚实决定,被委托人 D 是该节点**另一条** role id 的**真**成员、只把节点名字说了出来:成员身份成立、占位容量也成立(1 行 ≤ 1 席),但 A 的节点一条决定记录都没有 ⇒ 原审批主体无从还原 ⇒ 409 seat_unresolvable、零行。修复前实测 `seats=[D, E]`、A 丢失', async () => {
    const fixture = await roleNodeFirstOriginal('g3cred-forgery3', {
      roleApprover: 'otherUserE',
      secondRow: 'forged',
      roleAssigneeIds: ['admin', 'auditor'],
      membershipFor: [
        { who: 'otherUserE' },
        // FORGERY3 的全部要害:D 是**另一条** role id 的真成员,所以「唯一满足成员身份的人」这条
        // 门审原话里的判据对他**成立** —— 这也是本实现与门审 (b) 字面写法分岔的地方,已在设计 MD 登记。
        { who: 'delegateeD', roleId: 'auditor' },
      ],
    })
    // 隔离前置四条 —— 这条腿只有在**前两条合取都通过**时才对结算合取有判别力:
    // ① 节点 2 行席位;② D 在库里确有 `auditor` 成员记录;③ D 在该节点只有 **1** 条 approve 行
    // (≤ 他够得着的 1 席 ⇒ 容量合取通过);④ A 的节点 `approval_a` 的 approve 行数为 **0**
    // (= 结算合取的触发条件)。
    expect(fixture.roleSeatRows).toBe(2)
    const membership = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_roles WHERE user_id = $1 AND role_id = 'auditor'`,
      [fixture.delegateeD],
    )
    expect(membership.rows[0]?.n).toBe('1')
    const actorRowsAtRoleNode = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_records
        WHERE instance_id = $1 AND action = 'approve' AND actor_id = $2
          AND metadata->>'nodeKey' = 'approval_role'`,
      [fixture.documentId, fixture.delegateeD],
    )
    expect(actorRowsAtRoleNode.rows[0]?.n).toBe('1')
    const rowsAtDelegatedNode = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_records
        WHERE instance_id = $1 AND action = 'approve' AND metadata->>'nodeKey' = 'approval_a'`,
      [fixture.documentId],
    )
    expect(rowsAtDelegatedNode.rows[0]?.n).toBe('0')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
      fixture.otherUserE,
    ])
    expect(attempt.seats).toEqual([])
    // **这条腿答的是「阻断」,不是「[A, E]」。** 任务书写的是「FORGERY3 复核 [A, E] 不丢 A」;
    // 门审 §1.2 的裁决要求原话是「应**阻断或**还原到 A」。还原到 A 需要从一条**没有凭据**的行里猜出
    // 它结的是哪个节点 —— 同形的「一个委托人 + 行不可归属」在本文件里早已由 `delegate_not_seat` 臂
    // 判成**阻断**(`P12(a)`/`N7(a)`/`N8(a)`/`P13(a)`),这里再猜一次就是两套判据打架。
    // `[A, E]` 的门槛参照物是诚实兄弟腿 `P24(a)`,与 `N14(a)`/`P23(a)` 的配对方式完全一致。
  })

  it('§2-G3 第三句 负控 P27(a)(**本轮修法新造的残留**,钉今天的答案)— 结算合取取的是**弱**形式:第三人 E(没有任何委托)走 legacy 把 nodeKey 报成 **A 的节点**,就把该节点「点亮」成有决定记录;于是 D 的角色行照常放行 ⇒ 席位 `[D, E]`,**A 丢了**、不阻断', async () => {
    const fixture = await roleNodeFirstOriginal('g3cred-thirdlit', {
      roleApprover: 'delegateeD',
      secondRow: 'thirdPartyLegacy',
      roleAssigneeIds: ['admin', 'auditor'],
      membershipFor: [{ who: 'delegateeD' }],
    })
    // 前置正控:E 在本单上**没有**任何被委托席位(所以他走的是「从无委托席位 ⇒ 本人」那条早退臂),
    // 且 A 的节点现在确有一条 approve 行(结算合取被满足的原因)。
    const eDelegatedSeats = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_assignments
        WHERE instance_id = $1 AND assignee_id = $2 AND metadata->>'delegatedFrom' IS NOT NULL`,
      [fixture.documentId, fixture.otherUserE],
    )
    expect(eDelegatedSeats.rows[0]?.n).toBe('0')
    const rowsAtDelegatedNode = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_records
        WHERE instance_id = $1 AND action = 'approve' AND metadata->>'nodeKey' = 'approval_a'`,
      [fixture.documentId],
    )
    expect(rowsAtDelegatedNode.rows[0]?.n).toBe('1')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    // MEASURED,不是预测。**这条腿不主张 `[D, E]` 是对的**:它钉的是弱形式结算合取的代价 ——
    // 「那个节点被谁决定的」本轮仍然无法从库里分辨,因为 legacy 路由的 `nodeKey` 来自请求体。
    // 根治仍然是 (c)(让 legacy 路由自己写 `nodeKey`),属 owner 的合同变更,设计 MD §3.4 已登记。
    // 将来若被修好,这条腿会红并点名自己。
    expect(attempt.thrown).toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegateeD, fixture.otherUserE])
    expect(attempt.seats).not.toContain(fixture.delegatorA)
  })

  /**
   * `start → approval_role → approval_a → approval_c → end` + 委托 A→D。
   *
   * 比 `roleNodeFirstOriginal` 多一个**第三个节点**,唯一目的是给占位容量合取造一条**隔离**腿:
   * D 先诚实地按掉角色节点、再诚实地以 A 的代理结掉 `approval_a`(于是结算合取**通过**),
   * 然后在第三个节点上**多发一条** legacy 行、把 nodeKey 报成**角色节点** ——
   * 成员身份通过、结算通过,只有「一席只能被同一个人占一次」判死它。
   *   · `closer: 'thirdPartyE'` —— 第三个节点由 E 诚实按掉(正控 `P26(a)`,三席门槛见证);
   *   · `closer: 'delegateeDForgedRole'` —— D 走 legacy 多报一条角色节点行(负控 `N20(a)`)。
   */
  async function roleNodeDelegatedThirdOriginal(
    label: string,
    opts: { closer: 'thirdPartyE' | 'delegateeDForgedRole' },
  ): Promise<{
    documentId: string
    requesterId: string
    delegatorA: string
    delegateeD: string
    otherUserE: string
    roleSeatRows: number
  }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-r3req-${suffix}`
    const delegatorA = `wi4-r3A-${suffix}`
    const delegateeD = `wi4-r3D-${suffix}`
    const otherUserE = `wi4-r3E-${suffix}`
    const adminId = `wi4-r3adm-${suffix}`
    const delegationId = `wi4-r3deleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)
    const tokenE = await authToken(baseUrl, otherUserE)
    await grantRoleMembership(delegateeD, 'admin')

    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )

    const templateId = await publishGraphTemplate(
      adminToken,
      {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_role',
            type: 'approval',
            config: { assigneeType: 'role', assigneeIds: ['admin', 'auditor'], approvalMode: 'single' },
          },
          {
            key: 'approval_a',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [delegatorA], approvalMode: 'single' },
          },
          {
            key: 'approval_c',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [otherUserE], approvalMode: 'single' },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-r', source: 'start', target: 'approval_role' },
          { key: 'e-r-a', source: 'approval_role', target: 'approval_a' },
          { key: 'e-a-c', source: 'approval_a', target: 'approval_c' },
          { key: 'e-c-end', source: 'approval_c', target: 'end' },
        ],
      } as unknown as ReturnType<typeof oneNodeGraph>,
      label,
    )

    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    const first = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(first.status, `approval_role: ${await first.clone().text()}`).toBe(200)
    const second = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(second.status, `approval_a: ${await second.clone().text()}`).toBe(200)

    if (opts.closer === 'thirdPartyE') {
      const third = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenE, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(third.status, `approval_c: ${await third.clone().text()}`).toBe(200)
    } else {
      const versionRow = await pool().query<{ version: number }>(
        `SELECT version FROM approval_instances WHERE id = $1`,
        [documentId],
      )
      const legacy = await jsonRequest(baseUrl, `/api/approvals/${documentId}/approve`, tokenD, {
        method: 'POST',
        body: { version: versionRow.rows[0].version, metadata: { nodeKey: 'approval_role' } },
      })
      expect(legacy.status, `legacy: ${await legacy.clone().text()}`).toBe(200)
    }

    const seats = await pool().query<{ node_key: string | null; assignment_type: string; assignee_id: string; df: string | null }>(
      `SELECT node_key, assignment_type, assignee_id, metadata->>'delegatedFrom' AS df
         FROM approval_assignments WHERE instance_id = $1 ORDER BY node_key, assignee_id`,
      [documentId],
    )
    const roleSeatRows = seats.rows.filter((row) => row.node_key === 'approval_role').length
    expect(roleSeatRows).toBe(2)
    expect(seats.rows.filter((row) => row.node_key === 'approval_a')).toEqual([
      { node_key: 'approval_a', assignment_type: 'user', assignee_id: delegateeD, df: delegatorA },
    ])
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY id`,
      [documentId],
    )
    expect(records.rows).toEqual([
      { actor_id: delegateeD, node_key: 'approval_role' },
      { actor_id: delegateeD, node_key: 'approval_a' },
      opts.closer === 'thirdPartyE'
        ? { actor_id: otherUserE, node_key: 'approval_c' }
        : { actor_id: delegateeD, node_key: 'approval_role' },
    ])
    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')
    return { documentId, requesterId, delegatorA, delegateeD, otherUserE, roleSeatRows }
  }

  it('§2-G3 第三句 正控 P26(a)(`N20(a)` 的诚实兄弟腿 / 三席门槛见证)— 三个节点全部诚实结掉(D 按角色节点 + D 以 A 的代理结 approval_a + E 按自己的节点):席位是 {A, D, E} **三席**', async () => {
    const fixture = await roleNodeDelegatedThirdOriginal('g3cred-honest5', { closer: 'thirdPartyE' })
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    expect(attempt.thrown, 'an honest document must stay cancellable').toBeFalsy()
    expect(attempt.seats).toEqual([fixture.delegatorA, fixture.delegateeD, fixture.otherUserE])
    expect(attempt.seats.length).toBe(3)
  })

  it('§2-G3 第三句 负控 N20(a)(**占位容量合取的隔离见证**)— D 诚实地按掉角色节点、也诚实地结掉 A 的节点(结算合取因此通过、成员身份也通过),然后**多发一条** legacy 行把 nodeKey 再报一次角色节点:同一席不能被同一个人占两次 ⇒ 409 seat_unresolvable、零行', async () => {
    const fixture = await roleNodeDelegatedThirdOriginal('g3cred-forgery5', { closer: 'delegateeDForgedRole' })
    // 隔离前置三条 —— 只有它们都成立,这条腿才是**容量**那一半的见证:
    // ① D 有服务端 `admin` 成员记录 ⇒ 成员身份通过;
    // ② A 的节点 `approval_a` 有 D 的一条诚实 approve 行 ⇒ 结算合取通过(A 还原得回来);
    // ③ D 在角色节点上有 **2** 条 approve 行,而他够得着的席位只有 **1** 席(`admin`;另一席是
    //    `auditor`,他不在里面)⇒ 只剩容量那一半能判死它。
    const membership = await pool().query<{ role_id: string }>(
      `SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id`,
      [fixture.delegateeD],
    )
    expect(membership.rows.map((row) => row.role_id)).toEqual(['admin'])
    const rowsAtDelegatedNode = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_records
        WHERE instance_id = $1 AND action = 'approve' AND actor_id = $2
          AND metadata->>'nodeKey' = 'approval_a'`,
      [fixture.documentId, fixture.delegateeD],
    )
    expect(rowsAtDelegatedNode.rows[0]?.n).toBe('1')
    const actorRowsAtRoleNode = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_records
        WHERE instance_id = $1 AND action = 'approve' AND actor_id = $2
          AND metadata->>'nodeKey' = 'approval_role'`,
      [fixture.documentId, fixture.delegateeD],
    )
    expect(actorRowsAtRoleNode.rows[0]?.n).toBe('2')
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    await expectSeatBlock(attempt, { ineligibleCount: 2, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
      fixture.otherUserE,
    ])
    expect(attempt.seats).toEqual([])
    // 门槛参照物是诚实兄弟腿 `P26(a)` 的**三席**。注意阻断是**整单**的:D 那条诚实的 `approval_a`
    // 行本可以把 A 还原回来,但裁决说的是「阻断」而不是「过滤掉坏行继续开」——
    // 撤销节点是 `approvalMode: 'all'`,丢一席就是悄悄降门槛(`R7-M3` 那一族)。
  })

  it('§2-G3 第三句 负控 N17(a)(门审第 3 轮 P2-1:此前的**未测守卫**)— 同一个 (instance, node, assignee) 上出现**两个不同的** delegatedFrom(节点重入在 epoch 之间改写了委托所留下的残留)⇒ 没有唯一的原审批主体 ⇒ 409 seat_unresolvable、零行,既不猜也不回退给 D', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-twinseat')
    const secondDelegatorB = `wi4-twinB-${TS}`
    await authToken(baseUrl, secondDelegatorB)
    // 旧 epoch 的孪生席位行。`idx_approval_assignments_active_unique` 是 `WHERE is_active = true`
    // 的**部分**唯一索引、且**不含** `node_key`,所以一条 `is_active = FALSE` 的孪生行被现行 schema
    // 接受 —— 这不是绕过约束,是约束本来就允许的形状。
    //
    // **诚实分界(不过度声明)**:这是**夹具级 INSERT**,它忠实表示了节点重入在旧 epoch 留下的席位
    // 残留(`dispatchAction` 的 `return` 分支先 `bumpNodeActivationSeq` 再 `insertAssignments`,
    // `adminJump` / 节点超时跳转同形,旧行只被置 `is_active = FALSE` 而不删除),但**没有**经由
    // shipped 流程端到端走一遍。端到端夹具待补;机制本身在仓内,不是假想。
    const existing = await pool().query<{ entry_epoch: number | null }>(
      `SELECT entry_epoch FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_a'`,
      [fixture.documentId],
    )
    expect(existing.rows.length).toBe(1)
    const inserted = await pool().query(
      `INSERT INTO approval_assignments
         (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, entry_epoch, metadata)
       VALUES ($1, 'user', $2, 0, 'approval_a', FALSE, $3, $4::jsonb)`,
      [
        fixture.documentId,
        fixture.delegateeD,
        (existing.rows[0]?.entry_epoch ?? 1) - 1,
        JSON.stringify({ delegatedFrom: secondDelegatorB }),
      ],
    )
    expect(inserted.rowCount).toBe(1)
    // 前置正控:这一臂的**触发条件**确实成立(两个不同的 delegatedFrom 落在同一个 (instance, node,
    // assignee) 上)。少了这一句,阻断可能来自别的臂,断言就没有判别力。
    const distinctDelegators = await pool().query<{ df: string | null }>(
      `SELECT DISTINCT metadata->>'delegatedFrom' AS df
         FROM approval_assignments
        WHERE instance_id = $1 AND node_key = 'approval_a' AND assignment_type = 'user'
          AND assignee_id = $2 ORDER BY 1`,
      [fixture.documentId, fixture.delegateeD],
    )
    expect(distinctDelegators.rows.map((row) => row.df)).toEqual([fixture.delegatorA, secondDelegatorB].sort())
    const attempt = await attemptCancelRound(fixture.documentId, fixture.requesterId)
    await expectSeatBlock(attempt, { ineligibleCount: 1, reasons: ['seat_unresolvable'] }, [
      fixture.delegatorA,
      fixture.delegateeD,
      secondDelegatorB,
    ])
    expect(attempt.seats).toEqual([])
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 硬化轮 P2-3 —— 被候选自己点名的**兄弟界面**:`loadPriorNodeApproverDeciders`(Lock-1 §K3)
  // 同样从 `approval_records(action='approve')` 推导席位、同样丢哨兵(共用 `isSystemSentinelActor`),
  // 但**不做委托还原**。候选只对其中一半应用了还原,而这个不对称此前既未求值也未登记。
  //
  // 本腿不主张它是缺陷,它**钉今天的答案**:同一张单据上两个界面**同时**求值,答案不同 ——
  //   · 兄弟界面(`prior_node_approver` 节点的席位):**D** —— 这条腿**实测**的是「席位 = 实际决定人,
  //     `delegatedFrom` 为空、`resolvedFrom.kind = 'prior_node_approver'`,没有任何还原发生」。
  //     「同实例内冻结映射仍在生效、D 就是 A 在这张单据上的履职代理」是**建议不外推的理由**(语义判断),
  //     **不是**这条断言测到的东西 —— 两者分开写,不让理由借断言的光;
  //   · 撤销轮(新实例,冻结映射不适用):节点 1 还原成 **A**,节点 2 D 自己的席位仍是 **D**。
  // 「读法 (a) 是否外推到兄弟界面」是 owner 级语义裁决,已按 half B 同等待遇登记进设计 MD §3.4。
  // 若 owner 裁定外推,候选就是**部分应用**,须同 PR 改两处,而这条腿会**红**并点名自己。
  //
  // 结构上这条腿是 P11(a) 的兄弟(两个节点、一条委托),因此在「删 node_key 合取」那条 mutation 下
  // 它与 P11(a) 同向红 —— 它**不是**该合取的独立证据,台账里按实测归因,不当第二个 oracle 引用。
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * `approval_a` names A (substituted to D by the delegation); `approval_b` is a Lock-1 §K3
   * `prior_node_approver` node referencing `approval_a`, so its seat is whoever ACTUALLY decided
   * `approval_a` — read off the same audit trail the cancel-round seat query reads, with no
   * delegation restore of its own.
   */
  async function delegatedPriorNodeApproverOriginal(label: string): Promise<{
    documentId: string
    requesterId: string
    delegatorA: string
    delegateeD: string
  }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-preq-${suffix}`
    const delegatorA = `wi4-pelA-${suffix}`
    const delegateeD = `wi4-pelD-${suffix}`
    const adminId = `wi4-padm-${suffix}`
    const delegationId = `wi4-pdeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)

    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )

    const templateId = await publishGraphTemplate(
      adminToken,
      {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_a',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [delegatorA], approvalMode: 'single' },
          },
          {
            key: 'approval_b',
            type: 'approval',
            config: {
              assigneeSources: [{ kind: 'prior_node_approver', nodeKey: 'approval_a' }],
              approvalMode: 'single',
              emptyAssigneePolicy: 'error',
            },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
          { key: 'e-b-end', source: 'approval_b', target: 'end' },
        ],
      } as unknown as ReturnType<typeof oneNodeGraph>,
      label,
    )

    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    const approveA = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveA.status, await approveA.clone().text()).toBe(200)

    // THE P2-3 MEASUREMENT, taken on the sibling surface itself and asserted BEFORE the cancel
    // round exists: `approval_b`'s seat is D — `loadPriorNodeApproverDeciders` seats the person who
    // pressed the button, with no `delegatedFrom` and no restore. `resolvedFrom.kind` is asserted
    // too, so the leg cannot pass because the seat came from somewhere else entirely.
    const siblingSeat = await pool().query<{
      assignee_id: string
      delegated_from: string | null
      resolved_kind: string | null
    }>(
      `SELECT assignee_id,
              metadata->>'delegatedFrom' AS delegated_from,
              metadata->'resolvedFrom'->>'kind' AS resolved_kind
         FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_b'`,
      [documentId],
    )
    expect(siblingSeat.rows).toEqual([
      { assignee_id: delegateeD, delegated_from: null, resolved_kind: 'prior_node_approver' },
    ])

    const approveB = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveB.status, await approveB.clone().text()).toBe(200)

    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY metadata->>'nodeKey'`,
      [documentId],
    )
    expect(records.rows).toEqual([
      { actor_id: delegateeD, node_key: 'approval_a' },
      { actor_id: delegateeD, node_key: 'approval_b' },
    ])

    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')
    return { documentId, requesterId, delegatorA, delegateeD }
  }

  it('§2-G3 第三句 正控 P14(a) (P2-3) — 兄弟界面 `loadPriorNodeApproverDeciders` 不做委托还原:同一张单据上 §K3 节点的席位是**实际决定人 D**(delegatedFrom 为空、resolvedFrom.kind = prior_node_approver),而撤销轮的席位是 {A, D};是否外推属 owner,已登记', async () => {
    const { documentId, requesterId, delegatorA, delegateeD } = await delegatedPriorNodeApproverOriginal('g3dlg-prior')

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
    // `wi4-pelA-…` < `wi4-pelD-…`: the ORDER BY fixes the expected order.
    expect(seatRows.rows.map((row) => row.assignee_id)).toEqual([delegatorA, delegateeD])
    // 两个界面的答案并排写出来:兄弟界面的 D 席位(fixture 内已断言)在原单上原封不动,
    // 撤销轮把节点 1 还原成 A、把 D 在节点 2 经 §K3 拿到的席位留给 D 自己。
    const siblingStillD = await pool().query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_b'`,
      [documentId],
    )
    expect(siblingStillD.rows.map((row) => row.assignee_id)).toEqual([delegateeD])
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 硬化轮 P3-2 —— 设计 MD §3.4 自陈「同一个人既有角色席位、又有被委托的 user 席位 ⇒ 席位数塌缩」是
  // 「Owner call; not decided here, and not covered by a test」。本腿**只钉今天的答案**,不预判裁决:
  // 读法 (a) 下「一个人一个席位」自洽 —— 但相对基线,这是一次**会签门槛下降**(2 席 → 1 席),
  // 而在此之前连「今天的答案是什么」都没有钉子。理由与 P12(a) 完全同构。
  // 委托只替换 `assignmentType === 'user'` 的席位(`ApprovalAssigneeResolver.pushResolved` 的
  // `if (assignmentType === 'user')`),所以角色席位上的 A **本人**是 actor,user 席位上是代理 D ——
  // 还原之后两条 approve 行指向同一个人,`DISTINCT` 把两席折成一席。
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * `approval_role` is a ROLE seat (`assigneeType: 'role'`, role `admin`) that A approves IN PERSON;
   * `approval_user` is a USER seat naming A, substituted to D by the delegation. Two approve rows,
   * two different actors, two seats before the restore.
   */
  async function roleSeatPlusDelegatedUserSeatOriginal(label: string): Promise<{
    documentId: string
    requesterId: string
    delegatorA: string
    delegateeD: string
  }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-rreq-${suffix}`
    const delegatorA = `wi4-relA-${suffix}`
    const delegateeD = `wi4-relD-${suffix}`
    const adminId = `wi4-radm-${suffix}`
    const delegationId = `wi4-rdeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    // A acts IN PERSON at the role node, so A needs a token here (the other delegation fixtures
    // only need A's directory row).
    const tokenA = await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)

    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )

    const templateId = await publishGraphTemplate(
      adminToken,
      {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_role',
            type: 'approval',
            // `assigneeType: 'role'` (the legacy shape, as in approval-can-decide-current-node
            // .db.test.ts): every token this file mints carries `roles=admin`, and
            // `assignmentMatchesActor` matches a ROLE seat on `actorRoles.includes(assignee_id)`.
            config: { assigneeType: 'role', assigneeIds: ['admin'], approvalMode: 'single' },
          },
          {
            key: 'approval_user',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [delegatorA], approvalMode: 'single' },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-r', source: 'start', target: 'approval_role' },
          { key: 'e-r-u', source: 'approval_role', target: 'approval_user' },
          { key: 'e-u-end', source: 'approval_user', target: 'end' },
        ],
      } as unknown as ReturnType<typeof oneNodeGraph>,
      label,
    )

    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    // 正控先行:角色席位真的是 ROLE 行(未被委托替换),user 席位真的是被替换过的 D 行。
    // 没有这一句,整条腿可以因为「角色节点根本没产生席位」或「角色席位也被替换了」而平凡通过 ——
    // 本文件每个 token 都带 `roles=admin`,A 能不能按按钮并不能证明席位形状对。
    const roleSeat = await pool().query<{
      assignment_type: string
      assignee_id: string
      delegated_from: string | null
    }>(
      `SELECT assignment_type, assignee_id, metadata->>'delegatedFrom' AS delegated_from
         FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_role'`,
      [documentId],
    )
    expect(roleSeat.rows).toEqual([{ assignment_type: 'role', assignee_id: 'admin', delegated_from: null }])

    const approveRole = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenA, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveRole.status, await approveRole.clone().text()).toBe(200)

    const userSeat = await pool().query<{
      assignment_type: string
      assignee_id: string
      delegated_from: string | null
    }>(
      `SELECT assignment_type, assignee_id, metadata->>'delegatedFrom' AS delegated_from
         FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_user'`,
      [documentId],
    )
    expect(userSeat.rows).toEqual([
      { assignment_type: 'user', assignee_id: delegateeD, delegated_from: delegatorA },
    ])

    const approveUser = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveUser.status, await approveUser.clone().text()).toBe(200)

    // 两条 approve 行,两个**不同的** actor:角色节点是 A 本人,user 节点是代理 D。
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY metadata->>'nodeKey'`,
      [documentId],
    )
    expect(records.rows).toEqual([
      { actor_id: delegatorA, node_key: 'approval_role' },
      { actor_id: delegateeD, node_key: 'approval_user' },
    ])

    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')
    return { documentId, requesterId, delegatorA, delegateeD }
  }

  it('§2-G3 第三句 正控 P15(a) (P3-2) — 角色席位 + 被委托 user 席位:还原后两条 approve 行同指 A ⇒ 席位数从 2 塌成 1(= 今天的答案;相对基线是一次会签门槛下降,取舍属 owner,已登记)', async () => {
    const { documentId, requesterId, delegatorA, delegateeD } = await roleSeatPlusDelegatedUserSeatOriginal('g3dlg-rolecol')

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
    // 数写成断言,而不是只看身份:基线(候选前)在这张单据上是 {A, D} **两席**,
    // 读法 (a) 下是 **一席**。撤销节点是 `approvalMode: 'all'`,所以这就是会签门槛 2 → 1。
    expect(seats.length).toBe(1)
  })
})
