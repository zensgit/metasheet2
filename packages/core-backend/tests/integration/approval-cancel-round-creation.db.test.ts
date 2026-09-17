import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
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

describeIfDatabase('createCancelRoundInstance (WI-4): creation', () => {
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

    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'ok')
    const documentId = await createApprovedOriginal(requesterId, requesterToken, approverToken, templateId)

    // Judgment I (两向), REVERSE direction (lock §14.1: "经公开 createApproval ⇒ 谓词假") — the
    // ORIGINAL document, created through the public `createApproval` path, must NOT satisfy the
    // cancel-round predicate. Gate review impl-gate-C-slice1-round1-20260918.md P1-B row 3: this
    // direction had no assertion anywhere in the corpus (only the forward "专用路径 ⇒ 谓词真"
    // direction was covered, by the `isCancelRoundInstance(instance!)).toBe(true)` assertion below
    // for the DEDICATED instance). Discriminating power confirmed by a source mutation probe (cp
    // backup -> edit ApprovalProductService.ts's public-path `workflow_key` literal to the
    // dedicated value -> rerun -> restore -> cmp identical; recorded in the verification MD).
    const originalInstanceRow = await pool().query<{ workflow_key: string | null }>(
      `SELECT workflow_key FROM approval_instances WHERE id = $1`,
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
})
