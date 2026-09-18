import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'
import { executeApprovalTemplateGroupBackfill } from '../../src/routes/approvals'
import {
  listApprovalTemplateGroupBackfillBatches,
  rollbackApprovalTemplateGroupBackfillBatch,
} from '../../src/services/ApprovalTemplateGroupService'
import type { ApprovalTemplateVisibilityActor } from '../../src/services/ApprovalProductService'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3 ("backfill
 * by existing category") real-DB acceptance for the **batch list** endpoint
 * (`listApprovalTemplateGroupBackfillBatches`, `src/services/ApprovalTemplateGroupService.ts`;
 * `GET /api/approval-template-groups/backfill/batches`, `src/routes/approvals.ts`).
 *
 * Provenance: `docs/development/approval-template-groups-phase2-backfill-design-20260918.md` §2.1 index /
 * §6.1 endpoint row / §13.1 changesRequired #5 — folded verbatim from the independent design-gate
 * verdict's P1-5 finding (`reviews/design-gate-A3-phase2-20260918.md`): before this endpoint
 * existed, a `batchId` appeared in exactly one place (execute's own response), so an operator
 * whose execute request timed out — or who simply wants to audit what has already been rolled
 * back — had no way to discover a `batchId` to pass to rollback at all. Sibling to the W7
 * preview / W8 execute / W9 rollback real-DB suites — same `describeIfDatabase` / `EXPECT_DB`
 * sentinel convention, same org-per-test-tag teardown shape.
 *
 * What THIS file covers: pagination (limit/offset) and `created_at DESC` ordering against
 * directly-inserted rows with controlled timestamps (so ordering assertions do not depend on real
 * clock skew between test statements), the `rolledBackAt` null-vs-set round trip through the
 * REAL rollback code path (not a manual UPDATE), org scoping (a foreign org's batches never leak
 * into the count or the page), and route wiring (admin/reader/unauthenticated + HTTP-level
 * cross-org isolation).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
const TS = Date.now()

async function canListen(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

// Copied (not imported) from the sibling preview/execute/rollback suites — same convention, no new
// shared export surface.
async function tok(
  base: string,
  userId: string,
  opts: { roles?: string; perms?: string; tenantId?: string } = {},
): Promise<string> {
  const params = new URLSearchParams({
    userId,
    roles: opts.roles ?? 'user',
    perms: opts.perms ?? '',
  })
  if (opts.tenantId) params.set('tenantId', opts.tenantId)
  const res = await fetch(`${base}/api/auth/dev-token?${params.toString()}`)
  return ((await res.json()) as { token: string }).token
}

async function httpReq(base: string, path: string, method: string, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

describeIfDatabase('approval template groups — phase 2 backfill batch list (design-gate A3-phase2 P1-5 / changesRequired #5)', () => {
  const templateIds: string[] = []
  const orgTags: string[] = []
  const batchIds: string[] = []
  let server: MetaSheetServer | undefined
  let base = ''

  itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    for (const code of ['approvals:read', 'approval-templates:manage']) {
      await query(`INSERT INTO permissions (code, name) VALUES ($1, $1) ON CONFLICT (code) DO NOTHING`, [code])
    }
  })

  afterAll(async () => {
    for (const id of batchIds.splice(0)) {
      await query(`DELETE FROM approval_template_group_backfill_batch_links WHERE batch_id = $1`, [id])
      await query(`DELETE FROM approval_template_group_backfill_batch_groups WHERE batch_id = $1`, [id])
      await query(`DELETE FROM approval_template_group_backfill_batches WHERE id = $1`, [id])
    }
    for (const org of orgTags.splice(0)) {
      await query(`DELETE FROM approval_template_group_backfill_batch_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_group_backfill_batch_groups WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_group_backfill_batches WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org])
    }
    for (const id of templateIds.splice(0)) {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [id])
    }
    await server?.stop()
  })

  // Same rationale as the sibling suites: `approval_templates` carries no org column, so a
  // template left linked-nowhere by one case stays an eligible candidate for a later case.
  afterEach(async () => {
    for (const id of templateIds.splice(0)) {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [id])
    }
  })

  function trackOrg(org: string): string {
    orgTags.push(org)
    return org
  }

  async function createTemplate(key: string, category: string | null): Promise<string> {
    const row = await query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, status, category, visibility_scope)
       VALUES ($1, $1, 'draft', $2, $3) RETURNING id`,
      [key, category, JSON.stringify({ type: 'all', ids: [] })],
    )
    const id = row.rows[0].id
    templateIds.push(id)
    return id
  }

  // Directly-inserted batch header row with a CALLER-CONTROLLED `created_at` — bypasses execute
  // entirely so ordering/pagination assertions do not depend on real clock skew between two
  // `execute` calls (Postgres `now()` inside two separate transactions issued microseconds apart
  // is not a reliable ordering oracle for a test). Batch headers carry no FK a bare INSERT here
  // would violate — the two detail tables are optional (a batch that touched zero groups is a
  // real, if today unreachable via execute's own eligible-category short-circuit, valid header row
  // — see W9's own file-header note on `..._batch_groups`-only membership).
  async function insertBatch(id: string, org: string, createdAt: string, rolledBackAt: string | null): Promise<void> {
    batchIds.push(id)
    await query(
      `INSERT INTO approval_template_group_backfill_batches (id, org_id, created_by, created_at, rolled_back_at)
       VALUES ($1, $2, 'list-probe', $3::timestamptz, $4::timestamptz)`,
      [id, org, createdAt, rolledBackAt],
    )
  }

  // P2-1 fix (`impl-gate-A3-round3-20260918.md`, E14): this file's own `sinkForeignTemplates` —
  // same convention, independently copied (not imported) from the sibling preview/execute/rollback
  // suites, same disclosure (omits `applyTemplateVisibilityFilter`, sound only under
  // `managerActor` — see those files' own copy of this comment for the full mechanism). Added here
  // because two of this file's `it`s below call the REAL `executeApprovalTemplateGroupBackfill`
  // (route-wiring admin, smoke) and were named by gate round 3 as 2 of the 10 un-sunk `execute`
  // calls this lane's real-DB step exposes to the 500-candidate cap
  // (`executeApprovalTemplateGroupBackfillWithClient` counts every org-unlinked storable template
  // BEFORE bucketing, `routes/approvals.ts:694-701`). This file's other three `it`s
  // (ordering/pagination, rolledBackAt/org-scoping, the cross-org HTTP isolation case) either
  // insert batch rows directly (`insertBatch`, no candidate query involved at all) or — the
  // cross-org case — never assert on `execRes`'s status/body, so they are unaffected either way;
  // left untouched, not silently exempted by a new prose claim.
  const FOREIGN_SINK_GROUP_NAME = '__a3_ci_foreign_template_sink__'
  const FOREIGN_SINK_SORT_ORDER = 999999

  async function sinkForeignTemplates(org: string, ownTemplateIds: readonly string[]): Promise<string> {
    const sinkGroupId = `atg_sink_${org}`
    await query(
      `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
       VALUES ($1, $2, $3, $4, 'sink')`,
      [sinkGroupId, org, FOREIGN_SINK_GROUP_NAME, FOREIGN_SINK_SORT_ORDER],
    )
    await query(
      `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
       SELECT $1, t.id, $2, 'sink', now()
         FROM approval_templates t
        WHERE NOT EXISTS (SELECT 1 FROM approval_template_group_links l WHERE l.org_id = $1 AND l.template_id = t.id)
          AND NOT (t.id = ANY($3::uuid[]))`,
      [org, sinkGroupId, ownTemplateIds],
    )
    return sinkGroupId
  }

  const managerActor: ApprovalTemplateVisibilityActor = {
    userId: `list-manager-${TS}`,
    departmentIds: [],
    roles: [],
    permissions: [],
    isTemplateManager: true,
  }

  it('orders by created_at DESC and paginates with limit/offset, with an accurate total independent of the page size', async () => {
    const org = trackOrg(`atgl-order-${TS}`)
    // Three rows, one hour apart, inserted in a DELIBERATELY non-chronological order — if the
    // service function's own ORDER BY (rather than insertion order or a table scan's physical
    // order) were not doing the work, this would catch it.
    await insertBatch(`atgbb_list_${TS}_mid`, org, '2026-01-01T12:00:00Z', null)
    await insertBatch(`atgbb_list_${TS}_oldest`, org, '2026-01-01T11:00:00Z', null)
    await insertBatch(`atgbb_list_${TS}_newest`, org, '2026-01-01T13:00:00Z', null)

    const page1 = await listApprovalTemplateGroupBackfillBatches(org, 2, 0)
    expect(page1.total).toBe(3)
    expect(page1.limit).toBe(2)
    expect(page1.offset).toBe(0)
    expect(page1.batches.map((b) => b.batchId)).toEqual([`atgbb_list_${TS}_newest`, `atgbb_list_${TS}_mid`])

    const page2 = await listApprovalTemplateGroupBackfillBatches(org, 2, 2)
    expect(page2.total).toBe(3) // total does not shrink to match the page
    expect(page2.batches.map((b) => b.batchId)).toEqual([`atgbb_list_${TS}_oldest`])
  })

  it('rolledBackAt is null for a not-yet-rolled-back batch and an ISO string for a rolled-back one, and org scoping excludes a foreign org entirely', async () => {
    const org = trackOrg(`atgl-scope-${TS}`)
    const otherOrg = trackOrg(`atgl-scope-other-${TS}`)
    await insertBatch(`atgbb_list_${TS}_open`, org, '2026-02-01T00:00:00Z', null)
    await insertBatch(`atgbb_list_${TS}_done`, org, '2026-02-02T00:00:00Z', '2026-02-03T00:00:00Z')
    await insertBatch(`atgbb_list_${TS}_foreign`, otherOrg, '2026-02-04T00:00:00Z', null) // newest overall — must NOT appear for `org`

    const page = await listApprovalTemplateGroupBackfillBatches(org, 20, 0)
    expect(page.total).toBe(2) // the foreign-org row is not counted
    expect(page.batches).toHaveLength(2)
    const byId = new Map(page.batches.map((b) => [b.batchId, b]))
    expect(byId.get(`atgbb_list_${TS}_open`)?.rolledBackAt).toBeNull()
    const done = byId.get(`atgbb_list_${TS}_done`)
    expect(done?.rolledBackAt).not.toBeNull()
    expect(new Date(done!.rolledBackAt as string).toISOString()).toBe('2026-02-03T00:00:00.000Z')
    expect(done?.createdBy).toBe('list-probe')
  })

  describe('route wiring: GET /api/approval-template-groups/backfill/batches (real HTTP, real guard)', () => {
    it('an admin actor gets 200 with the batch it just executed, and rolledBackAt flips from null to a timestamp after a real rollback', async () => {
      const org = trackOrg(`atgl-http-admin-${TS}`)
      // P2-1 fix (`impl-gate-A3-round3-20260918.md`, E14): this call point had no sink call and no
      // exemption comment — gate round 3 named it as one of the 10 un-sunk `execute` calls this
      // lane's real-DB step exposes to the 500-candidate cap.
      const httpAdminTpl = await createTemplate(`atgl-http-admin-tpl-${TS}`, 'HTTPList')
      await sinkForeignTemplates(org, [httpAdminTpl])
      const admin = await tok(base, `http-list-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

      const execRes = await httpReq(base, '/api/approval-template-groups/backfill/execute', 'POST', admin)
      expect(execRes.status).toBe(201)
      const execBody = (await execRes.json()) as { batchId: string }
      batchIds.push(execBody.batchId)

      const listRes = await httpReq(base, '/api/approval-template-groups/backfill/batches', 'GET', admin)
      expect(listRes.status).toBe(200)
      const listBody = (await listRes.json()) as {
        batches: Array<{ batchId: string; rolledBackAt: string | null }>
        total: number
      }
      const before = listBody.batches.find((b) => b.batchId === execBody.batchId)
      expect(before).toBeDefined()
      expect(before!.rolledBackAt).toBeNull()

      const rollbackRes = await httpReq(
        base,
        `/api/approval-template-groups/backfill/batches/${execBody.batchId}/rollback`,
        'POST',
        admin,
      )
      expect(rollbackRes.status).toBe(200)

      const listRes2 = await httpReq(base, '/api/approval-template-groups/backfill/batches', 'GET', admin)
      const listBody2 = (await listRes2.json()) as { batches: Array<{ batchId: string; rolledBackAt: string | null }> }
      const after = listBody2.batches.find((b) => b.batchId === execBody.batchId)
      expect(after?.rolledBackAt).not.toBeNull()
    })

    it('a foreign org never sees another org\'s batches over HTTP', async () => {
      const orgA = trackOrg(`atgl-http-crossA-${TS}`)
      const orgB = trackOrg(`atgl-http-crossB-${TS}`)
      await createTemplate(`atgl-http-crossA-tpl-${TS}`, 'CrossA')
      const adminA = await tok(base, `http-list-crossA-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgA })
      const adminB = await tok(base, `http-list-crossB-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgB })

      const execRes = await httpReq(base, '/api/approval-template-groups/backfill/execute', 'POST', adminA)
      const execBody = (await execRes.json()) as { batchId: string }
      batchIds.push(execBody.batchId)

      const listResB = await httpReq(base, '/api/approval-template-groups/backfill/batches', 'GET', adminB)
      expect(listResB.status).toBe(200)
      const listBodyB = (await listResB.json()) as { batches: Array<{ batchId: string }> }
      expect(listBodyB.batches.some((b) => b.batchId === execBody.batchId)).toBe(false)
    })

    it('an actor holding ONLY approvals:read (no approval-templates:manage) gets 403', async () => {
      const org = trackOrg(`atgl-http-reader-${TS}`)
      const reader = await tok(base, `http-list-reader-${TS}`, { roles: 'user', perms: 'approvals:read', tenantId: org })

      const res = await httpReq(base, '/api/approval-template-groups/backfill/batches', 'GET', reader)
      expect(res.status).toBe(403)
    })

    it('an unauthenticated request gets 401, not a silent 200', async () => {
      const res = await httpReq(base, '/api/approval-template-groups/backfill/batches', 'GET')
      expect(res.status).toBe(401)
    })
  })

  // Referenced so `executeApprovalTemplateGroupBackfill` / `rollbackApprovalTemplateGroupBackfillBatch`
  // and the manager actor stay used even if a future edit trims one of the earlier direct-insert
  // tests — keeps the imports self-justifying rather than a silent unused-import drift risk.
  it('smoke: executeApprovalTemplateGroupBackfill + rollbackApprovalTemplateGroupBackfillBatch both surface through the list unit function', async () => {
    const org = trackOrg(`atgl-smoke-${TS}`)
    // P2-1 fix (`impl-gate-A3-round3-20260918.md`, E14): this call point had no sink call and no
    // exemption comment — gate round 3 named it as one of the 10 un-sunk `execute` calls this
    // lane's real-DB step exposes to the 500-candidate cap.
    const smokeTpl = await createTemplate(`atgl-smoke-tpl-${TS}`, 'Smoke')
    await sinkForeignTemplates(org, [smokeTpl])
    const executed = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(executed.batchId).not.toBeNull()
    const batchId = executed.batchId as string
    batchIds.push(batchId)

    const beforeRollback = await listApprovalTemplateGroupBackfillBatches(org, 20, 0)
    expect(beforeRollback.batches.find((b) => b.batchId === batchId)?.rolledBackAt).toBeNull()

    await rollbackApprovalTemplateGroupBackfillBatch(org, batchId)

    const afterRollback = await listApprovalTemplateGroupBackfillBatches(org, 20, 0)
    expect(afterRollback.batches.find((b) => b.batchId === batchId)?.rolledBackAt).not.toBeNull()
  })
})
