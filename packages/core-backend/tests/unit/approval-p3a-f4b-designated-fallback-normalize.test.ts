import { beforeEach, describe, expect, it, vi } from 'vitest'

// P3-A F4-B — Lock-4 §3 (docs/development/approval-lock4-flow-policies-20260817.md) publish-time /
// normalize-time contract for `emptyAssigneePolicy: 'designated'` + `emptyAssigneeFallback`. Covers:
//   - the enum widening (§1.3 four-allowlist arithmetic, allowlist 1 — the BACKEND rebuild spread)
//   - B-s10: cross-field publish-time fail-closed 400 when 'designated' carries no fallback
//   - the `{userIds: [], roleIds: []}` present-but-empty case normalizes identically to absent
//   - unknown-key rejection (Lock-1 §G-1 posture for new kinds)
// This file does NOT touch the FE allowlists (templateAuthoring.ts / approvalNodeEdit.ts) — those
// are scoped to F4-B's FE follower slice (B-2), per the scout brief's slice split. Without that
// follower slice, 'designated' is unreachable from either editor today (linear hydration flattens
// it to 'error'; the canvas validator rejects the save) — a deliberate §2.1 deferral (no control
// renders before its enforcement lands), not an oversight.

// Mirrors approval-lock8-date-range.test.ts's own pgState shape/pattern exactly.
const state = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  pool: { query: vi.fn(), connect: vi.fn() },
}))

vi.mock('../../src/db/pg', () => ({
  pool: state.pool,
}))

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function buildApprovalGraph(nodeConfigOverrides: Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['mgr-1'], ...nodeConfigOverrides },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
      { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
}

/** Wires the minimal INSERT-only DB mock a successful `createTemplate` call needs. */
function mockSuccessfulCreate(tplId: string, verId: string) {
  state.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = normalize(sql)
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (s.startsWith('INSERT INTO approval_templates')) {
      return {
        rows: [{
          id: tplId, key: String(params?.[0]), name: String(params?.[1]), description: null, category: null,
          visibility_scope: JSON.parse(String(params?.[4])), sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: null,
          created_at: new Date('2026-08-19T00:00:00.000Z'), updated_at: new Date('2026-08-19T00:00:00.000Z'),
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
          created_at: new Date('2026-08-19T00:00:00.000Z'), updated_at: new Date('2026-08-19T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('UPDATE approval_templates')) {
      return {
        rows: [{
          id: tplId, key: `key-${tplId}`, name: 'F4-B Tpl', description: null, category: null,
          visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: verId,
          created_at: new Date('2026-08-19T00:00:00.000Z'), updated_at: new Date('2026-08-19T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled query: ${s}`)
  })
}

describe('P3-A F4-B designated fallback — publish/normalize contract (Lock-4 §3)', () => {
  beforeEach(() => {
    state.pool.connect.mockReset()
    state.pool.query.mockReset()
    state.client.query.mockReset()
    state.client.release.mockReset()
    state.pool.connect.mockResolvedValue(state.client)
  })

  const create = async (approvalGraphOverrides: Record<string, unknown>) => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    return new ApprovalProductService().createTemplate({
      key: `f4b-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: 'F4-B Tpl',
      formSchema: { fields: [] },
      approvalGraph: buildApprovalGraph(approvalGraphOverrides),
    } as never)
  }

  it("normalize accepts 'designated' as a valid emptyAssigneePolicy value (enum widened)", async () => {
    mockSuccessfulCreate('tpl-f4b-1', 'ver-f4b-1')
    const result = await create({
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: { userIds: ['admin-1'] },
    })
    const node = result.approvalGraph.nodes.find((n) => n.key === 'approval_1')!
    expect((node.config as Record<string, unknown>).emptyAssigneePolicy).toBe('designated')
  })

  it('rejects an off-enum emptyAssigneePolicy value (still fail-closed after the widening)', async () => {
    await expect(create({ emptyAssigneePolicy: 'auto-reject-typo' })).rejects.toThrow(
      /emptyAssigneePolicy must be error, auto-approve, or designated/,
    )
  })

  it('allowlist 1 (§1.3): emptyAssigneeFallback SURVIVES the backend rebuild spread on create (not silently dropped)', async () => {
    mockSuccessfulCreate('tpl-f4b-2', 'ver-f4b-2')
    const result = await create({
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: { userIds: ['admin-1', 'admin-2'], roleIds: ['approval-admin'] },
    })
    const node = result.approvalGraph.nodes.find((n) => n.key === 'approval_1')!
    expect((node.config as Record<string, unknown>).emptyAssigneeFallback).toEqual({
      userIds: ['admin-1', 'admin-2'],
      roleIds: ['approval-admin'],
    })
  })

  it("B-s10: 'designated' with emptyAssigneeFallback OMITTED 400s at the authoring choke — APPROVAL_EMPTY_ASSIGNEE_FALLBACK_REQUIRED, not a runtime-only failure", async () => {
    await expect(create({ emptyAssigneePolicy: 'designated' })).rejects.toThrow(
      /emptyAssigneeFallback is required when emptyAssigneePolicy is 'designated'/,
    )
    await expect(create({ emptyAssigneePolicy: 'designated' })).rejects.toMatchObject({
      code: 'APPROVAL_EMPTY_ASSIGNEE_FALLBACK_REQUIRED',
      statusCode: 400,
    })
  })

  it('B-s10: {userIds: [], roleIds: []} (present but content-empty) is treated identically to an OMITTED fallback — still 400s', async () => {
    await expect(create({
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: { userIds: [], roleIds: [] },
    })).rejects.toMatchObject({ code: 'APPROVAL_EMPTY_ASSIGNEE_FALLBACK_REQUIRED' })
  })

  it("B-s10 negative control: 'designated' WITH a non-empty fallback publishes successfully", async () => {
    mockSuccessfulCreate('tpl-f4b-3', 'ver-f4b-3')
    await expect(create({
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: { userIds: ['admin-1'] },
    })).resolves.toBeDefined()
  })

  it("'error' and 'auto-approve' are unaffected by the B-s10 cross-field rule (it is 'designated'-selected)", async () => {
    mockSuccessfulCreate('tpl-f4b-4', 'ver-f4b-4')
    await expect(create({ emptyAssigneePolicy: 'error' })).resolves.toBeDefined()
    mockSuccessfulCreate('tpl-f4b-5', 'ver-f4b-5')
    await expect(create({ emptyAssigneePolicy: 'auto-approve' })).resolves.toBeDefined()
  })

  // Fix-round P2-3 (gate P3A-F4B-20260819) — the symmetric direction of B-s10: `emptyAssigneeFallback`
  // is a DANGLING key under any policy other than 'designated' (types/approval-product.ts's own
  // contract). Before the fix these two normalized/persisted successfully and then bricked BOTH
  // FE editors read-only (P1-1's blast radius), even though the author never touched the new feature.
  it("P2-3: rejects emptyAssigneeFallback present when emptyAssigneePolicy is 'error' (dangling key)", async () => {
    await expect(create({
      emptyAssigneePolicy: 'error',
      emptyAssigneeFallback: { userIds: ['admin-1'] },
    })).rejects.toMatchObject({
      code: 'APPROVAL_EMPTY_ASSIGNEE_FALLBACK_NOT_ALLOWED',
      statusCode: 400,
    })
  })

  it('P2-3: rejects emptyAssigneeFallback present when emptyAssigneePolicy is ABSENT entirely (dangling key)', async () => {
    await expect(create({
      emptyAssigneeFallback: { userIds: ['admin-1'] },
    })).rejects.toMatchObject({ code: 'APPROVAL_EMPTY_ASSIGNEE_FALLBACK_NOT_ALLOWED' })
  })

  it('P2-3: X-4 values-free — the rejection message carries the node key and policy name only, never the fallback ids', async () => {
    await expect(create({
      emptyAssigneePolicy: 'auto-approve',
      emptyAssigneeFallback: { userIds: ['admin-secret-1'] },
    })).rejects.toMatchObject({
      code: 'APPROVAL_EMPTY_ASSIGNEE_FALLBACK_NOT_ALLOWED',
      message: expect.not.stringContaining('admin-secret-1'),
    })
  })

  it('emptyAssigneeFallback rejects an unknown key (Lock-1 §G-1 posture for new kinds — no silent drop)', async () => {
    await expect(create({
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: { userIds: ['admin-1'], extra: true },
    })).rejects.toThrow(/emptyAssigneeFallback carries unknown keys: extra/)
  })

  it('legacy behavior byte-identical: a graph with neither emptyAssigneePolicy nor emptyAssigneeFallback normalizes with NEITHER key present', async () => {
    mockSuccessfulCreate('tpl-f4b-6', 'ver-f4b-6')
    const result = await create({})
    const node = result.approvalGraph.nodes.find((n) => n.key === 'approval_1')!
    const config = node.config as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(config, 'emptyAssigneePolicy')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(config, 'emptyAssigneeFallback')).toBe(false)
  })

  // B-s10 is enforced ONLY at the five authoring entry points (create/update/publish/restore/clone),
  // never on the dispatch/read re-normalize path — the lock's own words are "fail-closed at the
  // AUTHORING CHOKE, not at dispatch." This is the regression test for that boundary: a row that
  // could only exist if it predates the rule (or was written directly) — 'designated' with NO
  // emptyAssigneeFallback at all — must still be READABLE via getTemplate (ordinary read, mirrors the
  // "compatibility GOLDEN: ordinary reads still return a historical ... graph" pattern already shipped
  // in approval-product-service.test.ts), never throwing on the read path.
  it('B-s10 boundary: getTemplate (ordinary read) does NOT enforce the cross-field rule — a stored designated-with-no-fallback row still reads back rather than throwing on load', async () => {
    const graph = buildApprovalGraph({ emptyAssigneePolicy: 'designated' })
    const template = {
      id: 'tpl-f4b-read', key: 'f4b-read', name: 'F4-B Read Tpl', description: null, category: null,
      visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
      active_version_id: null, latest_version_id: 'ver-f4b-read',
      created_at: new Date('2026-08-19T00:00:00.000Z'), updated_at: new Date('2026-08-19T00:00:00.000Z'),
    }
    const version = {
      id: 'ver-f4b-read', template_id: 'tpl-f4b-read', version: 1, status: 'draft',
      form_schema: { fields: [] }, approval_graph: graph,
      created_at: new Date('2026-08-19T00:00:00.000Z'), updated_at: new Date('2026-08-19T00:00:00.000Z'),
    }
    state.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE')) return { rows: [template], rowCount: 1 }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) return { rows: [version], rowCount: 1 }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) return { rows: [], rowCount: 0 }
      throw new Error(`Unhandled pool query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const result = await new ApprovalProductService().getTemplate('tpl-f4b-read')
    const node = result?.approvalGraph.nodes.find((n) => n.key === 'approval_1')!
    expect((node.config as Record<string, unknown>).emptyAssigneePolicy).toBe('designated')
    expect(Object.prototype.hasOwnProperty.call(node.config as Record<string, unknown>, 'emptyAssigneeFallback')).toBe(false)
  })
})
