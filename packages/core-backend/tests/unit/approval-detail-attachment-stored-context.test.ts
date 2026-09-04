import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// REGRESSION (approval-detail-leaf-attachment-pin-20260904 round 2, gate F1): read-path parity
// for a TEMPLATE ALREADY STORED with an attachment column inside a `detail` group.
//
// Round 1 of this branch made `DETAIL_LEAF_FIELD_TYPES` exclude `attachment` UNCONDITIONALLY,
// which is correct for the WRITE path (`REQUEST_VALIDATION_CONTEXT`: createTemplate/updateTemplate
// must reject this shape in both flag states, pinned by approval-detail-attachment-leaf-probe
// .test.ts) but ALSO reached `STORED_FORM_SCHEMA_CONTEXT` — the context `asFormSchema` uses to
// re-validate `form_schema` that is already persisted (getTemplate, getTemplateVersion, publish,
// instance-create, frozen-schema runtime load). Because flag-OFF createTemplate historically
// accepted this exact shape (the bug round 1's fix closes going forward), a template saved during
// that window can exist in the DB today. Making the exclusion unconditional would flip such a
// template from "readable" (flag OFF, on origin/main) to "500s on every read" (flag OFF, on this
// branch) for data nobody touched — a blast-radius change to stored data, not just to new writes.
//
// This file pins the CORRECTED contract at the read path:
//   - flag OFF: getTemplate succeeds and returns the stored attachment column verbatim — BYTE-
//     IDENTICAL to origin/main's behavior, both before and after round 1's regression.
//   - flag ON: getTemplate throws APPROVAL_TEMPLATE_SCHEMA_INVALID (500) via the PRE-EXISTING
//     flag-gated sweep inside `assertFormSchema` (`isApprovalAttachmentsEnabled()` branch) — the
//     SAME behavior origin/main has always had for this shape, now reachable again in this one
//     context (round 1 had made it unreachable everywhere).
// Also re-affirms the WRITE path directly against `createTemplate` (already pinned by the sibling
// probe file; duplicated narrowly here so this file alone proves both halves of the F1 design:
// write rejects unconditionally, read tolerates only for already-stored data).

const pgState = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function buildRuntimeGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
      { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
}

const STORED_FORM_SCHEMA_WITH_ATTACHMENT_DETAIL_COLUMN = {
  fields: [
    {
      id: 'items',
      type: 'detail',
      label: '明细',
      columns: [
        { id: 'qty', type: 'number', label: '数量' },
        { id: 'file', type: 'attachment', label: '附件' },
      ],
    },
  ],
}

/** A template + its latest/only version, as `SELECT * FROM approval_templates` / `_versions` would return it. */
function mockStoredTemplate(tplId: string, verId: string) {
  const template = {
    id: tplId, key: `key-${tplId}`, name: 'Stored Attachment-Leaf Tpl', description: null, category: null,
    visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
    active_version_id: null, latest_version_id: verId,
    created_at: new Date('2026-09-01T00:00:00.000Z'), updated_at: new Date('2026-09-01T00:00:00.000Z'),
  }
  const version = {
    id: verId, template_id: tplId, version: 1, status: 'draft',
    form_schema: STORED_FORM_SCHEMA_WITH_ATTACHMENT_DETAIL_COLUMN,
    approval_graph: buildRuntimeGraph(),
    created_at: new Date('2026-09-01T00:00:00.000Z'), updated_at: new Date('2026-09-01T00:00:00.000Z'),
    publish_note: null, restored_from_version_id: null,
  }
  pgState.pool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = normalize(sql)
    if (s.startsWith('SELECT * FROM approval_templates WHERE')) {
      return params?.[0] === tplId ? { rows: [template], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (s.startsWith('SELECT * FROM approval_template_versions WHERE id = $1 AND template_id = $2')) {
      return params?.[0] === verId && params?.[1] === tplId ? { rows: [version], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (s.startsWith('SELECT * FROM approval_published_definitions')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unhandled pool query: ${s}`)
  })
}

const FLAG = 'APPROVAL_ATTACHMENTS_ENABLED'

describe('REGRESSION (F1): stored form_schema with an attachment detail column — read-path parity with origin/main', () => {
  const savedFlag = process.env[FLAG]

  beforeEach(() => {
    pgState.pool.query.mockReset()
    pgState.pool.connect.mockReset()
  })

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
  })

  it('flag OFF (shipped default): getTemplate SUCCEEDS and returns the stored attachment column verbatim', async () => {
    delete process.env[FLAG]
    const { isApprovalAttachmentsEnabled } = await import('../../src/routes/approval-attachments')
    expect(isApprovalAttachmentsEnabled()).toBe(false)

    mockStoredTemplate('tpl-stored-attach-off', 'ver-stored-attach-off')
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const result = await new ApprovalProductService().getTemplate('tpl-stored-attach-off')

    expect(result).not.toBeNull()
    expect(result?.formSchema.fields[0].columns).toEqual([
      { id: 'qty', type: 'number', label: '数量' },
      { id: 'file', type: 'attachment', label: '附件' },
    ])
  })

  it('flag ON: getTemplate THROWS APPROVAL_TEMPLATE_SCHEMA_INVALID (500) via the flag-gated sweep — same as origin/main', async () => {
    process.env[FLAG] = 'true'
    const { isApprovalAttachmentsEnabled } = await import('../../src/routes/approval-attachments')
    expect(isApprovalAttachmentsEnabled()).toBe(true)

    mockStoredTemplate('tpl-stored-attach-on', 'ver-stored-attach-on')
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    await expect(new ApprovalProductService().getTemplate('tpl-stored-attach-on')).rejects.toMatchObject({
      statusCode: 500,
      code: 'APPROVAL_TEMPLATE_SCHEMA_INVALID',
      message: 'attachment fields are not allowed inside detail groups',
    })
  })

  it('WRITE path is unaffected by the read-path tolerance: createTemplate with the same shape is REJECTED at 400, both flag states', async () => {
    const wrap = () => ({
      key: `stored-attach-write-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: 'Stored Attachment-Leaf Tpl (write attempt)',
      formSchema: STORED_FORM_SCHEMA_WITH_ATTACHMENT_DETAIL_COLUMN,
      approvalGraph: buildRuntimeGraph(),
    })
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')

    delete process.env[FLAG]
    await expect(new ApprovalProductService().createTemplate(wrap() as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: expect.stringMatching(/columns\[1\]\.type is not a valid leaf sub-field/),
    })

    process.env[FLAG] = 'true'
    await expect(new ApprovalProductService().createTemplate(wrap() as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: expect.stringMatching(/columns\[1\]\.type is not a valid leaf sub-field/),
    })

    // The pool mock above answers SELECTs only — createTemplate never gets far enough to need a
    // connection, confirming rejection happens at validation time, before any write is attempted.
    expect(pgState.pool.connect).not.toHaveBeenCalled()
  })
})
