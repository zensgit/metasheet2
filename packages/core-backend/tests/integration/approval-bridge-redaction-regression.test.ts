import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApprovalBridgeService } from '../../src/services/ApprovalBridgeService'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// Real-DB regression spec: runs only with a Postgres DATABASE_URL. Excluded from
// the no-DB default test job → skipped here (the `sentinel` test below makes a
// silent skip impossible to mistake for a pass).
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

/**
 * R2 regression guard for hidden-field redaction on the PUBLIC read seam.
 *
 * `GET /api/approvals/:id` resolves through `ApprovalBridgeService.getApproval`,
 * whose `toUnifiedDTO` mapper runs `redactHiddenFormFields` — so a field a node
 * marks `hidden` is stripped from the echoed `formSnapshot`. The SIBLING method
 * `ApprovalProductService.getApproval` returns the snapshot UN-redacted; the
 * route is wired to the bridge precisely because of that asymmetry. (This test
 * deliberately does NOT assert on the un-redacted ProductService path — that
 * would lock a wart and block a future hardening of ProductService.)
 *
 * The existing HTTP test (`approval-p1c-field-permissions.api.test.ts`) covers
 * the end-to-end route. This guard is a faster, server-less assertion on the
 * exact service method the route depends on, exercising the real
 * `loadApprovalInstance → loadRuntimeGraphs → toUnifiedDTO →
 * redactHiddenFormFields / collectActiveNodeKeys` chain over real rows (NOT a
 * hand-built fixture handed straight to the pure function). It catches a future
 * read path that swaps the bridge for an un-redacting method.
 */
describeIfDatabase('ApprovalBridgeService.getApproval hidden-field redaction (R2 regression)', () => {
  const pool = poolManager.get()
  const seeded = { instanceId: '', templateId: '' }

  beforeAll(async () => {
    await ensureApprovalSchemaReady()

    // template → version → published_definition (runtime graph hides `secret` at
    // approval_1) → instance pinned AT approval_1 with both fields in the snapshot.
    const template = await pool.query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, status) VALUES ($1, $2, 'published') RETURNING id`,
      [`r2-redact-${Date.now()}`, 'R2 redaction regression'],
    )
    seeded.templateId = template.rows[0].id

    const version = await pool.query<{ id: string }>(
      `INSERT INTO approval_template_versions (template_id, version, form_schema, approval_graph)
       VALUES ($1, 1, $2, '{}'::jsonb) RETURNING id`,
      [
        seeded.templateId,
        JSON.stringify({
          fields: [
            { id: 'reason', type: 'text', label: 'Reason' },
            { id: 'secret', type: 'text', label: 'Secret' },
          ],
        }),
      ],
    )

    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: { fieldPermissions: [{ fieldId: 'secret', access: 'hidden' }] },
        },
        { key: 'end', type: 'end', config: {} },
      ],
    }
    const published = await pool.query<{ id: string }>(
      `INSERT INTO approval_published_definitions (template_id, template_version_id, runtime_graph)
       VALUES ($1, $2, $3) RETURNING id`,
      [seeded.templateId, version.rows[0].id, JSON.stringify(runtimeGraph)],
    )

    // Non-PLM id (isPlmId only matches the `plm:` prefix) so getApproval takes
    // the local read path. template_version_id left NULL so the form_schema
    // lookup branch is skipped — only redaction is under test here.
    seeded.instanceId = `r2-redact-instance-${Date.now()}`
    await pool.query(
      `INSERT INTO approval_instances (id, status, source_system, current_node_key, form_snapshot, published_definition_id)
       VALUES ($1, 'pending', 'platform', 'approval_1', $2, $3)`,
      [seeded.instanceId, JSON.stringify({ reason: 'trip', secret: 'classified' }), published.rows[0].id],
    )
  })

  afterAll(async () => {
    try {
      if (seeded.instanceId) {
        await pool.query('DELETE FROM approval_instances WHERE id = $1', [seeded.instanceId])
      }
      if (seeded.templateId) {
        // template delete cascades versions + published_definitions (FK ON DELETE CASCADE).
        await pool.query('DELETE FROM approval_templates WHERE id = $1', [seeded.templateId])
      }
    } catch {
      // ignore cleanup failures
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('strips the hidden field from the formSnapshot while keeping non-hidden fields', async () => {
    const dto = await new ApprovalBridgeService().getApproval(seeded.instanceId)
    expect(dto).not.toBeNull()
    // The redacting public seam: `secret` (hidden at approval_1) is gone, `reason` stays.
    expect(dto?.formSnapshot).not.toHaveProperty('secret')
    expect(dto?.formSnapshot).toHaveProperty('reason', 'trip')

    // Redaction is an echo-only transform — the stored snapshot is untouched.
    const stored = await pool.query<{ form_snapshot: Record<string, unknown> }>(
      'SELECT form_snapshot FROM approval_instances WHERE id = $1',
      [seeded.instanceId],
    )
    expect(stored.rows[0]?.form_snapshot).toMatchObject({ reason: 'trip', secret: 'classified' })
  })
})
