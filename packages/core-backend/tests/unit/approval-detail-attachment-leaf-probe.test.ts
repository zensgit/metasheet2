import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// REGRESSION (approval-detail-leaf-attachment-pin-20260904): does the backend template authoring
// gate admit an `attachment` column inside a `detail` group, and does the answer depend on
// APPROVAL_ATTACHMENTS_ENABLED?
//
// Drives the REAL entry point — `ApprovalProductService.createTemplate` → `assertFormSchema` →
// `normalizeDetailFieldParts` (`DETAIL_LEAF_FIELD_TYPES.has(...)`) — over the same INSERT-only pg
// mock the sibling `approval-lock8-date-range.test.ts` uses. `isApprovalAttachmentsEnabled(env =
// process.env)` reads the env FRESH per call (default-parameter evaluation), so the flag is
// toggled via `process.env` between cases without re-importing the module.
//
// HISTORY (this file started as a values-free PROBE against origin/main 5133df1c5d, before the
// fix in this commit): OBSERVED then was flag OFF (shipped default) → ACCEPTED, the attachment
// column surviving normalization verbatim (`DETAIL_LEAF_FIELD_TYPES.has('attachment')` was
// `true`); flag ON → REJECTED, but only by `assertFormSchema`'s separate flag-gated sweep
// (:1785-1792), not by the leaf check. That meant a template saved while the flag was OFF could
// carry an attachment column inside a detail group, then start 500ing at publish/read/instance-
// create once the flag was turned ON (those re-run the now-tightened check via `asFormSchema`).
// This file now pins the FIXED contract: `DETAIL_LEAF_FIELD_TYPES` excludes `attachment`
// unconditionally, so cases (a)/(b) below are both REJECT, with the SAME leaf-check message,
// regardless of flag state — the flag-gated sweep becomes unreachable for this case (kept as
// defense in depth) rather than being what makes rejection happen.

const pgState = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
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

/** Minimal INSERT-only DB mock a successful `createTemplate` needs (mirrors the date_range sibling). */
function mockSuccessfulCreate(tplId: string, verId: string) {
  pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = normalize(sql)
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (s.startsWith('INSERT INTO approval_templates')) {
      return {
        rows: [{
          id: tplId, key: String(params?.[0]), name: String(params?.[1]), description: null, category: null,
          visibility_scope: JSON.parse(String(params?.[4])), sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: null,
          created_at: new Date('2026-09-04T00:00:00.000Z'), updated_at: new Date('2026-09-04T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('INSERT INTO approval_template_versions')) {
      return {
        rows: [{
          id: verId, template_id: tplId, version: 1, status: 'draft',
          form_schema: JSON.parse(String(params?.[1])),
          approval_graph: JSON.parse(String(params?.[2])),
          created_at: new Date('2026-09-04T00:00:00.000Z'), updated_at: new Date('2026-09-04T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('UPDATE approval_templates')) {
      return {
        rows: [{
          id: tplId, key: `key-${tplId}`, name: 'Leaf Probe Tpl', description: null, category: null,
          visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: verId,
          created_at: new Date('2026-09-04T00:00:00.000Z'), updated_at: new Date('2026-09-04T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled query: ${s}`)
  })
}

type Outcome = { kind: 'ACCEPT'; leafTypes: string[] } | { kind: 'REJECT'; message: string; code?: string }

const FLAG = 'APPROVAL_ATTACHMENTS_ENABLED'

describe('REGRESSION: attachment column inside a detail group is rejected at template create (flag OFF and ON)', () => {
  const savedFlag = process.env[FLAG]

  beforeEach(() => {
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
  })

  const wrap = (field: Record<string, unknown>) => ({
    key: `leafprobe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Leaf Probe Tpl',
    formSchema: { fields: [field] },
    approvalGraph: buildRuntimeGraph(),
  })

  const detailWithAttachmentColumn = () => wrap({
    id: 'items', type: 'detail', label: '明细',
    columns: [
      { id: 'qty', type: 'number', label: '数量' },
      { id: 'file', type: 'attachment', label: '附件' },
    ],
  })

  const run = async (request: unknown): Promise<Outcome> => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    try {
      const result = await new ApprovalProductService().createTemplate(request as never)
      const leafTypes = (result.formSchema.fields[0].columns ?? []).map((c) => c.type)
      return { kind: 'ACCEPT', leafTypes }
    } catch (error) {
      const err = error as { message?: string; code?: string }
      return { kind: 'REJECT', message: String(err?.message ?? error), code: err?.code }
    }
  }

  it('preflight: DETAIL_LEAF_FIELD_TYPES excludes attachment even though FORM_FIELD_TYPES includes it', async () => {
    const { DETAIL_LEAF_FIELD_TYPES, FORM_FIELD_TYPES } = await import('../../src/services/ApprovalProductService')
    // attachment IS a valid top-level FormFieldType — the exclusion is specific to detail columns.
    expect(FORM_FIELD_TYPES.has('attachment')).toBe(true)
    expect(DETAIL_LEAF_FIELD_TYPES.has('attachment')).toBe(false)
  })

  it('(a) flag OFF (env unset): detail column {type: attachment} — REJECTED by the unconditional leaf check', async () => {
    delete process.env[FLAG]
    const { isApprovalAttachmentsEnabled } = await import('../../src/routes/approval-attachments')
    expect(isApprovalAttachmentsEnabled()).toBe(false)
    const outcome = await run(detailWithAttachmentColumn())
    expect(outcome.kind).toBe('REJECT')
    expect(outcome.kind === 'REJECT' ? outcome.message : '').toMatch(/columns\[1\]\.type is not a valid leaf sub-field/)
  })

  it('(b) flag ON: detail column {type: attachment} — REJECTED with the SAME leaf-check message (flag-gated sweep now unreachable)', async () => {
    process.env[FLAG] = 'true'
    const { isApprovalAttachmentsEnabled } = await import('../../src/routes/approval-attachments')
    expect(isApprovalAttachmentsEnabled()).toBe(true)
    const outcome = await run(detailWithAttachmentColumn())
    expect(outcome.kind).toBe('REJECT')
    expect(outcome.kind === 'REJECT' ? outcome.message : '').toMatch(/columns\[1\]\.type is not a valid leaf sub-field/)
    // Not the flag-gated sweep's distinct message — proves the leaf check pre-empts it.
    expect(outcome.kind === 'REJECT' ? outcome.message : '').not.toMatch(/attachment fields are not allowed inside detail groups/)
  })

  it('positive control: a number-only detail group is ACCEPTED under both flag states', async () => {
    delete process.env[FLAG]
    mockSuccessfulCreate('tpl-leaf-pc-off', 'ver-leaf-pc-off')
    const off = await run(wrap({ id: 'items', type: 'detail', label: '明细', columns: [{ id: 'qty', type: 'number', label: '数量' }] }))
    expect(off.kind).toBe('ACCEPT')

    process.env[FLAG] = 'true'
    mockSuccessfulCreate('tpl-leaf-pc-on', 'ver-leaf-pc-on')
    const on = await run(wrap({ id: 'items', type: 'detail', label: '明细', columns: [{ id: 'qty', type: 'number', label: '数量' }] }))
    expect(on.kind).toBe('ACCEPT')
  })

  it('negative control: a non-leaf column type (explanation) is REJECTED by the leaf check regardless of flag', async () => {
    delete process.env[FLAG]
    const outcome = await run(wrap({
      id: 'items', type: 'detail', label: '明细',
      columns: [{ id: 'note', type: 'explanation', label: '说明', props: { text: 'hint' } }],
    }))
    // eslint-disable-next-line no-console
    console.log('[probe] explanation-column outcome (flag OFF) =', JSON.stringify(outcome))
    expect(outcome.kind).toBe('REJECT')
    expect(outcome.kind === 'REJECT' ? outcome.message : '').toMatch(/is not a valid leaf sub-field/)
  })
})
