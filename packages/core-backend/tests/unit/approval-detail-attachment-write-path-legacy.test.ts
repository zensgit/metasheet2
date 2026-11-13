import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// REGRESSION (approval-detail-leaf-attachment-pin-20260904 round 3, gate finding R1): a stored
// template already carrying an attachment column inside a `detail` group (reachable pre-fix via
// flag-OFF createTemplate — see approval-detail-attachment-stored-context.test.ts) stays READABLE
// under round 2's F1 tolerance (STORED_FORM_SCHEMA_CONTEXT). But F1's tolerance is scoped to
// *reading* stored data — it must not leak into any path that PRODUCES a NEW
// `approval_template_versions` row from that stored data. This file pins the full write-side of
// the contract documented at DETAIL_LEAF_FIELD_TYPES's definition in ApprovalProductService.ts:
//
//   WRITE (mints a new version row) → REQUEST_VALIDATION_CONTEXT → rejects in BOTH flag states:
//     - updateTemplate's graph-only carry-forward (formSchema omitted from the request; the
//       STORED schema is carried into the new version — round 3's actual code fix: this used to
//       skip re-validation entirely, silently minting a new row with the legacy shape)
//     - cloneTemplate (already correct pre-round-3 — this file re-affirms it, since round 2 never
//       had a test for it and the round-2 report did not disclose this behaviour)
//     - restoreTemplateVersion (already correct pre-round-3 — same disclosure gap)
//   READ (only consumes stored data, mints nothing) → STORED_FORM_SCHEMA_CONTEXT → tolerates,
//   exactly like getTemplate:
//     - publishTemplate (flips the EXISTING version row's status; freezes a runtime_graph built
//       from the approval_graph, never a new form_schema) — flag OFF: publishable; flag ON: the
//       flag-gated sweep still 500s, same as any other read path.

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

const TPL_ID = 'tpl-legacy-attach'
const VER_ID = 'ver-legacy-attach'

function makeTemplateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TPL_ID, key: `key-${TPL_ID}`, name: 'Legacy Attachment-Leaf Tpl', description: null, category: null,
    visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
    active_version_id: null, latest_version_id: VER_ID,
    created_at: new Date('2026-09-01T00:00:00.000Z'), updated_at: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makeVersionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: VER_ID, template_id: TPL_ID, version: 1, status: 'draft',
    form_schema: STORED_FORM_SCHEMA_WITH_ATTACHMENT_DETAIL_COLUMN,
    approval_graph: buildRuntimeGraph(),
    created_at: new Date('2026-09-01T00:00:00.000Z'), updated_at: new Date('2026-09-01T00:00:00.000Z'),
    publish_note: null, restored_from_version_id: null,
    ...overrides,
  }
}

/**
 * A single query handler shared by BOTH `pool.query` (cloneTemplate reads its source bundle
 * directly off the pool, no transaction) and `client.query` (every other path here runs inside a
 * `pool.connect()` transaction) — the SQL text each issues is otherwise identical, so one
 * dispatch table covers both. Anything unrecognised throws loud rather than defaulting to an
 * empty result set, so a wrong-status pass under mutation can never be masked by a silent
 * `{ rows: [] }` (R4-style discipline, applied file-wide, not just at the connect() seam).
 */
function makeQueryHandler(templateRow: ReturnType<typeof makeTemplateRow>, versionRow: ReturnType<typeof makeVersionRow>) {
  return vi.fn(async (sql: string, params?: unknown[]) => {
    const s = normalize(sql)
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (s.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) {
      return params?.[0] === templateRow.id ? { rows: [templateRow], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (s.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
      return params?.[0] === templateRow.id ? { rows: [templateRow], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (s.startsWith('SELECT * FROM approval_template_versions WHERE id = $1 AND template_id = $2')) {
      return params?.[0] === versionRow.id && params?.[1] === templateRow.id
        ? { rows: [versionRow], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (s.startsWith('SELECT * FROM approval_template_versions WHERE template_id = $1 ORDER BY version DESC LIMIT 1')) {
      return params?.[0] === templateRow.id ? { rows: [versionRow], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (s.startsWith('SELECT COALESCE(MAX(version)')) {
      return { rows: [{ max_version: String(versionRow.version) }], rowCount: 1 }
    }
    if (s.startsWith('SELECT * FROM approval_published_definitions')) {
      return { rows: [], rowCount: 0 }
    }
    if (s.startsWith('UPDATE approval_published_definitions')) {
      return { rows: [], rowCount: 0 }
    }
    if (s.startsWith('INSERT INTO approval_templates')) {
      // Only reachable via cloneTemplate if a mutation defeats its write-path rejection — the
      // fresh-clone row it would create. Content is not asserted anywhere; only reachability
      // (does the mutated code get this far and succeed) matters for the mutation ledger.
      return {
        rows: [{
          id: 'tpl-should-not-be-minted', key: 'clone-should-not-be-minted', name: 'clone', description: null,
          category: null, visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: null,
          created_at: new Date('2026-09-01T00:00:00.000Z'), updated_at: new Date('2026-09-01T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('INSERT INTO approval_published_definitions')) {
      return {
        rows: [{
          id: 'pubdef-legacy-attach', template_id: templateRow.id, template_version_id: versionRow.id,
          runtime_graph: JSON.parse(String(params?.[2])), is_active: true, published_at: new Date('2026-09-01T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('UPDATE approval_template_versions SET status')) {
      return { rows: [{ ...versionRow, status: 'published', publish_note: params?.[1] ?? null }], rowCount: 1 }
    }
    if (s.startsWith('UPDATE approval_templates SET status')) {
      return { rows: [], rowCount: 0 }
    }
    if (s.startsWith('INSERT INTO approval_template_versions')) {
      // Only reachable if a mutation defeats the write-path rejection this file pins — a legacy
      // shape must never actually reach this INSERT under the shipped contract. Content is not
      // asserted anywhere in the mutation ledger's flows (only reachability/rejection is), and the
      // form_schema/approval_graph parameter POSITION differs between call sites (clone/create:
      // index 1/2; update/restore: index 2/3) — echo the row's own stored values instead of
      // guessing an index, so this stays correct for every caller without per-site branching.
      return {
        rows: [{
          id: 'ver-should-not-be-minted', template_id: templateRow.id, version: (versionRow.version as number) + 1,
          status: 'draft', form_schema: versionRow.form_schema, approval_graph: versionRow.approval_graph,
          created_at: new Date('2026-09-01T00:00:00.000Z'), updated_at: new Date('2026-09-01T00:00:00.000Z'),
          publish_note: null, restored_from_version_id: null,
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('UPDATE approval_templates SET latest_version_id')) {
      return { rows: [{ ...templateRow, latest_version_id: 'ver-should-not-be-minted', updated_at: new Date('2026-09-01T00:00:00.000Z') }], rowCount: 1 }
    }
    throw new Error(`Unhandled query in approval-detail-attachment-write-path-legacy: ${s}`)
  })
}

const FLAG = 'APPROVAL_ATTACHMENTS_ENABLED'

describe('R1: write paths that MINT a new template version reject a legacy stored attachment-in-detail column, both flag states', () => {
  const savedFlag = process.env[FLAG]

  beforeEach(() => {
    pgState.pool.query.mockReset()
    pgState.pool.connect.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
  })

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
  })

  function wireTransactionalClient() {
    const templateRow = makeTemplateRow()
    const versionRow = makeVersionRow()
    pgState.client.query.mockImplementation(makeQueryHandler(templateRow, versionRow))
    pgState.pool.connect.mockResolvedValue(pgState.client)
    return { templateRow, versionRow }
  }

  function wirePoolOnlyReads() {
    // R4 discipline, applied here too (not just at the connect() seam in the sibling stored-
    // context file): under the shipped code, cloneTemplate rejects reading straight off `pool`
    // and never calls `pool.connect()` — but under a mutation that defeats that rejection (see M2
    // below), cloneTemplate WOULD proceed to open a write transaction. Wiring `pool.connect()` to
    // a real INSERT-capable client here too means a defeated rejection actually SUCCEEDS instead
    // of crashing on an unconfigured `vi.fn()` — the assertion then fails on "expected rejection,
    // got a resolved value", not an opaque TypeError.
    const templateRow = makeTemplateRow()
    const versionRow = makeVersionRow()
    const handler = makeQueryHandler(templateRow, versionRow)
    pgState.pool.query.mockImplementation(handler)
    pgState.client.query.mockImplementation(handler)
    pgState.pool.connect.mockResolvedValue(pgState.client)
    return { templateRow, versionRow }
  }

  for (const flagValue of ['off', 'on'] as const) {
    const setFlag = () => {
      if (flagValue === 'off') delete process.env[FLAG]
      else process.env[FLAG] = 'true'
    }

    it(`updateTemplate graph-only carry-forward (flag ${flagValue}): REJECTS at 400 before minting a new version — R1's actual code fix`, async () => {
      setFlag()
      wireTransactionalClient()
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().updateTemplate(TPL_ID, {
        approvalGraph: buildRuntimeGraph(),
        // formSchema deliberately OMITTED — this is the graph-only carry-forward path.
      } as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: expect.stringMatching(/columns\[1\]\.type is not a valid leaf sub-field/),
      })
      // The rejecting call must never have reached the INSERT that would mint the new version.
      expect(pgState.client.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_template_versions'),
        expect.anything(),
      )
      // Positive control for the assertion above (feedback_positive_control_not_failclosed
      // discipline): prove the matcher SHAPE can match a call that actually happened on this same
      // mock, so the `.not.toHaveBeenCalledWith` isn't silently vacuous (e.g. wrong SQL text,
      // wrong arg arity, or a call convention `toHaveBeenCalledWith` can never match).
      expect(pgState.client.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM approval_templates'),
        expect.anything(),
      )
    })

    it(`cloneTemplate (flag ${flagValue}): REJECTS at 400 — already-correct behaviour, re-affirmed here`, async () => {
      setFlag()
      wirePoolOnlyReads()
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().cloneTemplate(TPL_ID)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: expect.stringMatching(/columns\[1\]\.type is not a valid leaf sub-field/),
      })
      // Rejection happens at validation time, reading the source bundle off the plain pool —
      // cloneTemplate never opens a write transaction for a source that fails re-validation.
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it(`restoreTemplateVersion (flag ${flagValue}): REJECTS at 400 — already-correct behaviour, re-affirmed here`, async () => {
      setFlag()
      const templateRow = makeTemplateRow({ latest_version_id: 'ver-current-latest' })
      const versionRow = makeVersionRow()
      pgState.client.query.mockImplementation(makeQueryHandler(templateRow, versionRow))
      pgState.pool.connect.mockResolvedValue(pgState.client)
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().restoreTemplateVersion(TPL_ID, VER_ID, {
        expectedLatestVersionId: 'ver-current-latest',
      } as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: expect.stringMatching(/columns\[1\]\.type is not a valid leaf sub-field/),
      })
      expect(pgState.client.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_template_versions'),
        expect.anything(),
      )
      // Positive control (same reasoning as updateTemplate's above) — proves the matcher shape
      // can match a real call on this mock, so the negative assertion above isn't vacuous.
      expect(pgState.client.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM approval_templates'),
        expect.anything(),
      )
    })
  }

  it('updateTemplate graph-only carry-forward: a NON-attachment stored-schema defect ALSO flips 500→400 — DISCLOSED SCOPE (advisor finding), not just the attachment case', async () => {
    // Switching the carry-forward re-validation from STORED_FORM_SCHEMA_CONTEXT to
    // REQUEST_VALIDATION_CONTEXT (this file's R1 fix) changes `failValidation`'s thrown
    // status/code for EVERY validation defect in the carried-forward schema, not only an
    // attachment-in-detail column — see the DISCLOSED SCOPE comment at the fix's call site. This
    // test proves it with an UNRELATED defect (duplicate field ids), with no attachment field
    // anywhere in the schema, so the leaf-check tolerance is not even in play here.
    delete process.env[FLAG]
    const dupTplId = 'tpl-legacy-dup-ids'
    const dupVerId = 'ver-legacy-dup-ids'
    const dupSchema = {
      fields: [
        { id: 'dup', type: 'text', label: 'A' },
        { id: 'dup', type: 'text', label: 'B' },
      ],
    }
    const templateRow = makeTemplateRow({ id: dupTplId, latest_version_id: dupVerId })
    const versionRow = makeVersionRow({ id: dupVerId, template_id: dupTplId, form_schema: dupSchema })
    pgState.client.query.mockImplementation(makeQueryHandler(templateRow, versionRow))
    pgState.pool.connect.mockResolvedValue(pgState.client)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    await expect(new ApprovalProductService().updateTemplate(dupTplId, {
      approvalGraph: buildRuntimeGraph(),
      // formSchema deliberately OMITTED — the graph-only carry-forward path.
    } as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: expect.stringMatching(/field ids must be unique/),
    })
  })

  it('publishTemplate (flag OFF): TOLERATES the legacy shape — READ classification, not a write of a new form_schema', async () => {
    delete process.env[FLAG]
    wireTransactionalClient()
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const result = await new ApprovalProductService().publishTemplate(TPL_ID, {
      policy: { allowRevoke: true },
      actorUserId: 'admin-1',
    } as never)
    expect(result.formSchema.fields[0].columns).toEqual([
      { id: 'qty', type: 'number', label: '数量' },
      { id: 'file', type: 'attachment', label: '附件' },
    ])
  })

  it('publishTemplate (flag ON): still THROWS APPROVAL_TEMPLATE_SCHEMA_INVALID via the flag-gated sweep — same as any other read path', async () => {
    process.env[FLAG] = 'true'
    wireTransactionalClient()
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    await expect(new ApprovalProductService().publishTemplate(TPL_ID, {
      policy: { allowRevoke: true },
      actorUserId: 'admin-1',
    } as never)).rejects.toMatchObject({
      statusCode: 500,
      code: 'APPROVAL_TEMPLATE_SCHEMA_INVALID',
      message: 'attachment fields are not allowed inside detail groups',
    })
  })
})
