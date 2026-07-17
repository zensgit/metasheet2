// Operator-UAT-as-integration: exercises the approval template-authoring MVP's
// real end-to-end path against a REAL Postgres + the REAL MetaSheetServer (no mocks) —
// create (authoring shape w/ form_field_user) -> publish (real buildRuntimeGraph compile)
// -> start (POST /api/approvals, the same backend the /approvals/new/:id UI calls)
// -> assert the approver resolves from the form field at runtime.
//
// This is the API+DB layer of the operator UAT. It does NOT drive the deployed browser UI
// (host-blocked); the FE fail-closed behaviour is covered by apps/web's authoring spec.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// tests/setup.ts replaces global fetch in its beforeAll. Capture Node's real implementation while
// this module is evaluated so this real-HTTP suite cannot silently call the empty test stub.
const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)

// Same self-guard as the other approval *.api.test.ts (e.g. approval-wp1): this suite boots a real
// MetaSheetServer + connects to Postgres, so it must SKIP when DATABASE_URL is unset (the unit
// `test (18.x/20.x)` jobs, which match tests/integration but provide no DB) and RUN in the
// DB-provisioned plugin-tests `test:integration` step.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const response = await realFetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
) {
  return await realFetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

// The exact shape the frontend authoring MVP emits (buildFormSchema / buildApprovalGraph in
// apps/web/src/approvals/templateAuthoring.ts): linear start->approval_1->end, a `user`-typed
// `reviewer` field, and a form_field_user assignee source pointing at it.
function authoringFormSchema() {
  return {
    fields: [
      { id: 'amount', type: 'number', label: 'Amount', required: true },
      { id: 'reviewer', type: 'user', label: 'Reviewer', required: true },
    ],
  }
}
function authoringApprovalGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 'Start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        name: 'Reviewer',
        config: {
          assigneeSources: [{ kind: 'form_field_user', fieldId: 'reviewer' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: 'End', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval template authoring MVP — operator UAT (real DB, no mocks)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let adminToken = ''
  let requesterToken = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address.port}`
    adminToken = await authToken(baseUrl, 'uat-admin')
    requesterToken = await authToken(baseUrl, 'uat-requester')
  })

  afterAll(async () => {
    const pool = poolManager.get()
    try {
      const approvalIds = [...createdApprovalIds]
      const templateIds = [...createdTemplateIds]
      if (approvalIds.length > 0) {
        await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await pool.query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
    } catch {
      // ignore cleanup failures
    }
    if (server) await server.stop()
  })

  it('create -> publish -> start: the form_field_user approver resolves to the submitted form value', async () => {
    // 1. CREATE (authoring-MVP shape) via the real route
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `uat-authoring-${Date.now()}`,
        name: 'UAT Authoring — Expense',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: authoringFormSchema(),
        approvalGraph: authoringApprovalGraph(),
      },
    })
    expect(createResp.status).toBe(201)
    const template = await createResp.json() as { id: string }
    expect(template.id).toBeTruthy()
    createdTemplateIds.add(template.id)

    // 2. VISIBLE in the template centre list
    const listResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken)
    expect(listResp.status).toBe(200)
    // List route envelope is { data, total, limit, offset } (approvals.ts:297).
    const listed = await listResp.json() as { data: Array<{ id: string }> }
    expect(listed.data.map((t) => t.id)).toContain(template.id)

    // 3. PUBLISH — runs the REAL approvalGraph -> runtimeGraph compile
    const publishResp = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect([200, 201]).toContain(publishResp.status)
    const published = await publishResp.json() as {
      runtimeGraph: { nodes: Array<{ key: string; config: Record<string, unknown> }> }
    }
    // The compile must PRESERVE the form_field_user assignee source (not drop/mangle it)
    const approvalNode = published.runtimeGraph.nodes.find((n) => n.key === 'approval_1')
    expect(approvalNode?.config?.assigneeSources).toEqual([{ kind: 'form_field_user', fieldId: 'reviewer' }])

    // 4. START via POST /api/approvals (the backend the /approvals/new/:id UI calls), submitting
    //    the reviewer field — the form_field_user source must resolve to THAT value.
    const startResp = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId: template.id, formData: { amount: 1200, reviewer: 'uat-approver-42' } },
    })
    expect(startResp.status).toBe(201)
    const approval = await startResp.json() as {
      id: string
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    createdApprovalIds.add(approval.id)

    // 5. ASSERT the approver resolved from the form field
    expect(approval.status).toBe('pending')
    expect(approval.currentNodeKey).toBe('approval_1')
    const activeAssignees = approval.assignments.filter((a) => a.isActive).map((a) => a.assigneeId)
    expect(activeAssignees).toEqual(['uat-approver-42'])
  })

  it('restores a historical version into one new draft under concurrent requests without changing the active version', async () => {
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `uat-version-restore-${Date.now()}`,
        name: 'UAT Version Restore',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: authoringFormSchema(),
        approvalGraph: authoringApprovalGraph(),
      },
    })
    expect(createResp.status).toBe(201)
    const created = await createResp.json() as { id: string; latestVersionId: string }
    createdTemplateIds.add(created.id)
    const v1Id = created.latestVersionId

    const publishResp = await jsonRequest(baseUrl, `/api/approval-templates/${created.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResp.status).toBe(200)

    const changedGraph = authoringApprovalGraph()
    changedGraph.nodes[1] = {
      key: 'approval_1',
      type: 'approval',
      name: 'Changed approver',
      config: {
        assigneeType: 'user',
        assigneeIds: ['uat-different-approver'],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    }
    const updateResp = await jsonRequest(baseUrl, `/api/approval-templates/${created.id}`, adminToken, {
      method: 'PATCH',
      body: { approvalGraph: changedGraph },
    })
    expect(updateResp.status).toBe(200)
    const updated = await updateResp.json() as { latestVersionId: string }
    const v2Id = updated.latestVersionId
    expect(v2Id).not.toBe(v1Id)

    const restorePath = `/api/approval-templates/${created.id}/versions/${v1Id}/restore`
    const [left, right] = await Promise.all([
      jsonRequest(baseUrl, restorePath, adminToken, {
        method: 'POST',
        body: { expectedLatestVersionId: v2Id },
      }),
      jsonRequest(baseUrl, restorePath, adminToken, {
        method: 'POST',
        body: { expectedLatestVersionId: v2Id },
      }),
    ])
    expect([left.status, right.status].sort()).toEqual([201, 409])
    const success = left.status === 201 ? left : right
    const stale = left.status === 409 ? left : right
    const restored = await success.json() as {
      id: string
      version: number
      status: string
      restoredFromVersionId: string
      approvalGraph: ReturnType<typeof authoringApprovalGraph>
    }
    const stalePayload = await stale.json() as { error: { code: string } }
    expect(stalePayload.error.code).toBe('APPROVAL_TEMPLATE_VERSION_STALE')
    expect(restored).toMatchObject({
      version: 3,
      status: 'draft',
      restoredFromVersionId: v1Id,
      approvalGraph: authoringApprovalGraph(),
    })

    const pool = poolManager.get()
    const templateRow = await pool.query<{
      active_version_id: string
      latest_version_id: string
      status: string
    }>(
      `SELECT active_version_id, latest_version_id, status
       FROM approval_templates
       WHERE id = $1`,
      [created.id],
    )
    expect(templateRow.rows[0]).toEqual({
      active_version_id: v1Id,
      latest_version_id: restored.id,
      status: 'published',
    })
    const versions = await pool.query<{
      id: string
      version: number
      status: string
      restored_from_version_id: string | null
    }>(
      `SELECT id, version, status, restored_from_version_id
       FROM approval_template_versions
       WHERE template_id = $1
       ORDER BY version`,
      [created.id],
    )
    expect(versions.rows).toHaveLength(3)
    expect(versions.rows[0]).toMatchObject({ id: v1Id, version: 1, status: 'published', restored_from_version_id: null })
    expect(versions.rows[2]).toMatchObject({
      id: restored.id,
      version: 3,
      status: 'draft',
      restored_from_version_id: v1Id,
    })
  })

  // P2-1 (review 20260717c): the restore-time snapshot revalidation is a PR-body Safety claim, so
  // it needs a discriminating real-DB negative. We SQL-INSERT a historical version row whose graph
  // references a form field that does not exist in its own snapshot — the shape a legitimately
  // stored version takes AFTER the authoring contract drifts — and prove restore fail-fasts 400
  // instead of copying the now-invalid snapshot into a new draft.
  it('rejects restoring a historical snapshot that violates the current authoring contract (400, no write)', async () => {
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `uat-restore-revalidation-${Date.now()}`,
        name: 'UAT Restore Revalidation',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: authoringFormSchema(),
        approvalGraph: authoringApprovalGraph(),
      },
    })
    expect(createResp.status).toBe(201)
    const created = await createResp.json() as { id: string; latestVersionId: string }
    createdTemplateIds.add(created.id)
    const v1Id = created.latestVersionId

    // Historical row with a graph whose form_field_user points at a field its own snapshot does
    // not define. Inserted via SQL on purpose: today's create/update APIs (correctly) refuse to
    // write this shape, which is exactly why only a drifted historical row can carry it.
    const invalidGraph = authoringApprovalGraph()
    invalidGraph.nodes[1] = {
      key: 'approval_1',
      type: 'approval',
      name: 'Reviewer',
      config: {
        assigneeSources: [{ kind: 'form_field_user', fieldId: 'ghost_reviewer' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    }
    const pool = poolManager.get()
    const insertedResult = await pool.query<{ id: string }>(
      `INSERT INTO approval_template_versions (template_id, version, status, form_schema, approval_graph)
       VALUES ($1, 2, 'draft', $2, $3)
       RETURNING id`,
      [created.id, JSON.stringify(authoringFormSchema()), JSON.stringify(invalidGraph)],
    )
    const invalidVersionId = insertedResult.rows[0].id

    const restoreResp = await jsonRequest(
      baseUrl,
      `/api/approval-templates/${created.id}/versions/${invalidVersionId}/restore`,
      adminToken,
      { method: 'POST', body: { expectedLatestVersionId: v1Id } },
    )
    expect(restoreResp.status).toBe(400)
    const payload = await restoreResp.json() as { error: { code: string; message: string } }
    expect(payload.error.code).toBe('VALIDATION_ERROR')
    // Typed + values-free: the message may name graph/node identifiers but must not echo the
    // snapshot's field values (the snapshot has none here; assert the envelope stays structural).
    expect(Object.keys(payload)).toEqual(['error'])

    // Fail-fast means fail-closed: no new version row, latest pointer untouched.
    const versions = await pool.query<{ version: number }>(
      `SELECT version FROM approval_template_versions WHERE template_id = $1 ORDER BY version`,
      [created.id],
    )
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2])
    const templateRow = await pool.query<{ latest_version_id: string }>(
      `SELECT latest_version_id FROM approval_templates WHERE id = $1`,
      [created.id],
    )
    expect(templateRow.rows[0].latest_version_id).toBe(v1Id)
  })

  // P3-2 (review 20260717c): the belongs-to-template (IDOR) guard was only discriminated in the
  // mocked unit lane; this is the real-DB negative — a version id that exists but belongs to a
  // DIFFERENT template must 404 without writing anything.
  it('404s a cross-template version id on restore without creating a draft (real DB)', async () => {
    const mkTemplate = async (label: string) => {
      const resp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
        method: 'POST',
        body: {
          key: `uat-restore-idor-${label}-${Date.now()}`,
          name: `UAT Restore IDOR ${label}`,
          visibilityScope: { type: 'all', ids: [] },
          formSchema: authoringFormSchema(),
          approvalGraph: authoringApprovalGraph(),
        },
      })
      expect(resp.status).toBe(201)
      const body = await resp.json() as { id: string; latestVersionId: string }
      createdTemplateIds.add(body.id)
      return body
    }
    const target = await mkTemplate('target')
    const other = await mkTemplate('other')

    const restoreResp = await jsonRequest(
      baseUrl,
      `/api/approval-templates/${target.id}/versions/${other.latestVersionId}/restore`,
      adminToken,
      { method: 'POST', body: { expectedLatestVersionId: target.latestVersionId } },
    )
    expect(restoreResp.status).toBe(404)
    const payload = await restoreResp.json() as { error: { code: string } }
    expect(payload.error.code).toBe('APPROVAL_TEMPLATE_VERSION_NOT_FOUND')

    const pool = poolManager.get()
    const targetVersions = await pool.query<{ version: number }>(
      `SELECT version FROM approval_template_versions WHERE template_id = $1 ORDER BY version`,
      [target.id],
    )
    expect(targetVersions.rows.map((row) => row.version)).toEqual([1])
    const targetRow = await pool.query<{ latest_version_id: string }>(
      `SELECT latest_version_id FROM approval_templates WHERE id = $1`,
      [target.id],
    )
    expect(targetRow.rows[0].latest_version_id).toBe(target.latestVersionId)
  })

  // P3-3 (review 20260717c): pins that updateTemplate PARTICIPATES in the same template-row lock
  // order restore uses (`SELECT ... FOR UPDATE` before reading MAX(version)), so a concurrent
  // restore-style writer can never make PATCH collide on UNIQUE(template_id, version) → 500.
  // Deterministic construction: a raw transaction holds the row lock and has already allocated
  // version 2 (exactly what an in-flight restore does); the PATCH fired underneath must QUEUE on
  // the lock, then allocate version 3 after commit. If the lock were dropped, the PATCH would read
  // MAX(version)=1 immediately and die on the unique index instead of returning 200.
  it('updateTemplate queues behind a concurrent restore-style writer instead of colliding on the version number', async () => {
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `uat-restore-lockorder-${Date.now()}`,
        name: 'UAT Restore Lock Order',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: authoringFormSchema(),
        approvalGraph: authoringApprovalGraph(),
      },
    })
    expect(createResp.status).toBe(201)
    const created = await createResp.json() as { id: string; latestVersionId: string }
    createdTemplateIds.add(created.id)

    const pool = poolManager.get()
    let patchPromise!: ReturnType<typeof jsonRequest>
    await pool.transaction(async ({ query }) => {
      await query('SELECT id FROM approval_templates WHERE id = $1 FOR UPDATE', [created.id])
      // The in-flight "restore": version 2 is allocated but not yet committed.
      await query(
        `INSERT INTO approval_template_versions (template_id, version, status, form_schema, approval_graph)
         VALUES ($1, 2, 'draft', $2, $3)`,
        [created.id, JSON.stringify(authoringFormSchema()), JSON.stringify(authoringApprovalGraph())],
      )

      patchPromise = jsonRequest(baseUrl, `/api/approval-templates/${created.id}`, adminToken, {
        method: 'PATCH',
        body: {
          formSchema: {
            fields: [
              ...authoringFormSchema().fields,
              { id: 'note', type: 'text', label: 'Note' },
            ],
          },
        },
      })
      // Give the PATCH time to reach the service transaction. With the row lock in place it MUST
      // still be pending here; without it, it has already claimed version 2 and is doomed.
      // Returning from the handler COMMITs and releases the row lock.
      await new Promise((resolve) => setTimeout(resolve, 400))
    })

    const patchResp = await patchPromise
    expect(patchResp.status).toBe(200)

    const versions = await pool.query<{ version: number }>(
      `SELECT version FROM approval_template_versions WHERE template_id = $1 ORDER BY version`,
      [created.id],
    )
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3])
  })
})
