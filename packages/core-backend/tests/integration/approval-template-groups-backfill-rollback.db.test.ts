import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'
import { executeApprovalTemplateGroupBackfill } from '../../src/routes/approvals'
import { rollbackApprovalTemplateGroupBackfillBatch } from '../../src/services/ApprovalTemplateGroupService'
import type { ApprovalTemplateVisibilityActor } from '../../src/services/ApprovalProductService'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3 ("backfill
 * by existing category") real-DB acceptance for **W9 rollback**
 * (`rollbackApprovalTemplateGroupBackfillBatch`, `src/services/ApprovalTemplateGroupService.ts`,
 * `docs/development/approval-template-groups-phase2-backfill-design-20260918.md` §4 / §13.1 changesRequired
 * #1/#2/#4/#7). Sibling to the W7 preview and W8 execute real-DB suites — same
 * `describeIfDatabase` / `EXPECT_DB` sentinel convention, same org-per-test-tag teardown shape.
 *
 * §13 changesRequired #13's three combined-call discriminating tests (concurrent
 * execute-vs-rollback L0 parking, the RR-pool SET-obligation grid, the lock-order "stopped at the
 * lock" assertion) are explicitly DEFERRED to a follow-up commit on this same branch — same
 * disposition W8's own suite recorded for its own concurrent-execute variant of the same
 * obligation; the design-gate report's "同 PR" text names a future Draft PR, not this commit.
 *
 * What THIS file covers: the happy-path unlink+archive shape, the §4.3 "created_new=false is
 * never archived" rule, the §4 "batch-external state is left untouched" precision guarantee in
 * BOTH its forms (an external member ADDED to a batch-created group keeps that group alive; an
 * external MOVE of a batch-linked template away from the recorded group makes that link's token
 * mismatch and rollback SKIPS it rather than force-clearing a group_id that is no longer even
 * `b.group_id`), the §13 changesRequired #7 409-not-idempotent-200 rule (with `details.rolledBackAt`),
 * the 404 not-found shape (including cross-org batchId lookup, which is indistinguishable from
 * not-found by design), and route wiring (admin/reader/unauthenticated).
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

// Copied (not imported) from the sibling preview/execute suites — same convention, no new shared
// export surface.
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

async function httpReq(base: string, path: string, method: string, token: string): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` } })
}

describeIfDatabase('approval template groups — phase 2 backfill rollback (W9, design-gate A3-phase2 §4)', () => {
  const templateIds: string[] = []
  const orgTags: string[] = []
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

  // §11 CI fix (shared-DB fixture collision — see the sibling preview suite's own copy of this
  // helper for the full mechanism comment): `executeApprovalTemplateGroupBackfill`'s `eligible`
  // query has the SAME "no template-level org filter, only the link-exclusion is org-scoped" shape,
  // so calling it from this file (every rollback fixture goes through a real `execute` first) is
  // equally exposed to a foreign, unrelated file's leftover `approval_templates` row in the shared
  // real-DB CI step. Copied (not imported) per this file's own convention for `tok`/`httpReq`. Like
  // every other copy in this lane, this omits `applyTemplateVisibilityFilter` — sound only because
  // every case in this file runs under `managerActor`, where that filter is a no-op.
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
    userId: `rollback-manager-${TS}`,
    departmentIds: [],
    roles: [],
    permissions: [],
    isTemplateManager: true,
  }

  interface OrgTableCounts {
    groups: number
    activeGroups: number
    links: number
    activeLinks: number
    batches: number
  }

  async function tableCounts(org: string): Promise<OrgTableCounts> {
    async function count(sql: string): Promise<number> {
      const result = await query<{ n: string }>(sql, [org])
      return Number(result.rows[0].n)
    }
    return {
      groups: await count(`SELECT count(*)::text AS n FROM approval_template_groups WHERE org_id = $1`),
      activeGroups: await count(`SELECT count(*)::text AS n FROM approval_template_groups WHERE org_id = $1 AND archived_at IS NULL`),
      links: await count(`SELECT count(*)::text AS n FROM approval_template_group_links WHERE org_id = $1`),
      activeLinks: await count(`SELECT count(*)::text AS n FROM approval_template_group_links WHERE org_id = $1 AND group_id IS NOT NULL`),
      batches: await count(`SELECT count(*)::text AS n FROM approval_template_group_backfill_batches WHERE org_id = $1`),
    }
  }

  it('happy path: rollback archives the batch-created group, unlinks the batch-linked templates, and stamps rolled_back_at', async () => {
    const org = trackOrg(`atgr-happy-${TS}`)
    const hr1 = await createTemplate(`atgr-hr1-${TS}`, 'HR')
    const hr2 = await createTemplate(`atgr-hr2-${TS}`, 'HR')
    await sinkForeignTemplates(org, [hr1, hr2])
    // §11 CI fix: baselined AFTER sinking, BEFORE execute — the sink's own group row (permanently
    // active) and any foreign links it just wrote would otherwise be counted into the absolute
    // numbers below. The DELTA across execute+rollback is what "one group created then archived,
    // two links created then unlinked, one batch" actually means once a sink group is present.
    const before = await tableCounts(org)
    const executed = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(executed.batchId).not.toBeNull()
    const batchId = executed.batchId as string

    const result = await rollbackApprovalTemplateGroupBackfillBatch(org, batchId)
    expect(typeof result.rolledBackAt).toBe('string')

    const after = await tableCounts(org)
    expect({
      groups: after.groups - before.groups,
      activeGroups: after.activeGroups - before.activeGroups,
      links: after.links - before.links,
      activeLinks: after.activeLinks - before.activeLinks,
      batches: after.batches - before.batches,
    }).toEqual({ groups: 1, activeGroups: 0, links: 2, activeLinks: 0, batches: 1 })

    const batchRow = await query<{ rolled_back_at: string | null }>(
      `SELECT rolled_back_at FROM approval_template_group_backfill_batches WHERE id = $1`,
      [batchId],
    )
    expect(batchRow.rows[0].rolled_back_at).not.toBeNull()
    expect(new Date(batchRow.rows[0].rolled_back_at as string).toISOString()).toBe(
      new Date(result.rolledBackAt).toISOString(),
    )
  })

  // §11 CI fix exemption: no `sinkForeignTemplates` call needed — every assertion below is scoped
  // to the SPECIFIC pre-existing `existingGroupId`/its own link row, never an org-wide count or
  // array. A foreign 'HR'-category pollutant, if present, gets pulled into this SAME batch/group by
  // `execute` (it is batch-INTERNAL, not batch-external, from rollback's point of view) and is
  // unlinked right alongside `tpl` — the `linkRow` toHaveLength(0) check holds either way.
  it('attach path: rollback unlinks the batch-linked template but does NOT archive a created_new=false group, even though it now has zero members', async () => {
    const org = trackOrg(`atgr-attach-${TS}`)
    const existingGroupId = `atg_rollback_attach_${TS}`
    await query(
      `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1, $2, $3, 1, 'probe')`,
      [existingGroupId, org, 'HR'],
    )
    await createTemplate(`atgr-attach-tpl-${TS}`, '  HR  ')

    const executed = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(executed.batchId).not.toBeNull()
    const batchId = executed.batchId as string

    await rollbackApprovalTemplateGroupBackfillBatch(org, batchId)

    const groupRow = await query<{ archived_at: string | null }>(
      `SELECT archived_at FROM approval_template_groups WHERE id = $1`,
      [existingGroupId],
    )
    expect(groupRow.rows).toHaveLength(1) // still exists
    expect(groupRow.rows[0].archived_at).toBeNull() // NOT archived — created_new was false

    const linkRow = await query<{ group_id: string | null }>(
      `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND group_id = $2`,
      [org, existingGroupId],
    )
    expect(linkRow.rows).toHaveLength(0) // the batch's own link WAS unlinked
  })

  // §4/§9's core precision guarantee, form 1: a batch-external ADDITION to a batch-created group,
  // made strictly AFTER execute and BEFORE rollback, must keep that group alive — rollback's
  // `remaining = 0` check (§4.3) is the ONLY thing standing between this and the group being
  // archived out from under the externally-added member. Verified with a mutation probe below.
  it('batch-external addition to a batch-created group survives rollback: the group stays active because it is not empty', async () => {
    const org = trackOrg(`atgr-extadd-${TS}`)
    const batchTpl = await createTemplate(`atgr-extadd-batch-${TS}`, 'HR')
    const result = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(result.batchId).not.toBeNull()
    const hrGroup = result.groups.find((g) => g.category === 'HR')
    expect(hrGroup?.action).toBe('create')
    const groupId = hrGroup!.groupId

    // Batch-external write: a manual link into the SAME group, on a SEPARATE (untracked-by-batch)
    // template — simulates an admin manually linking one more template after execute ran.
    const externalTpl = await createTemplate(`atgr-extadd-external-${TS}`, null)
    await query(
      `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
       VALUES ($1, $2, $3, 'external-probe', now())`,
      [org, externalTpl, groupId],
    )

    await rollbackApprovalTemplateGroupBackfillBatch(org, result.batchId as string)

    const groupRow = await query<{ archived_at: string | null }>(
      `SELECT archived_at FROM approval_template_groups WHERE id = $1`,
      [groupId],
    )
    expect(groupRow.rows[0].archived_at).toBeNull() // still active — the external member kept it non-empty

    const batchLinkRow = await query<{ group_id: string | null }>(
      `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, batchTpl],
    )
    expect(batchLinkRow.rows[0].group_id).toBeNull() // the batch's own member WAS unlinked

    const externalLinkRow = await query<{ group_id: string | null }>(
      `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, externalTpl],
    )
    expect(externalLinkRow.rows[0].group_id).toBe(groupId) // untouched — batch-external data survives
  })

  // §4/§9's core precision guarantee, form 2: a batch-external MOVE of a batch-linked template —
  // its `linked_at` (and here its `group_id`) no longer match what execute recorded — must be
  // SKIPPED by rollback's §4.2 token match, not force-unlinked using the stale recorded token.
  // Verified with a mutation probe below.
  it('a batch-linked template moved to a different group by a batch-external action is left exactly where the external action put it', async () => {
    const org = trackOrg(`atgr-extmove-${TS}`)
    const movedTpl = await createTemplate(`atgr-extmove-tpl-${TS}`, 'HR')
    // §11 CI fix: `result.groups[0]` below assumes exactly one category comes out of this org's
    // `execute` call — true in the reproduction pollution set on hand today (its one non-null
    // foreign row happens to also be category 'HR', folding into the SAME bucket), but NOT
    // guaranteed in general: a foreign row with a DIFFERENT ASCII category that sorts before 'HR'
    // would put a different group at index 0. Sinking closes the general case, not just today's.
    await sinkForeignTemplates(org, [movedTpl])
    const result = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(result.batchId).not.toBeNull()
    const originalGroupId = result.groups[0].groupId

    // Batch-external move: a different, unrelated active group, and a fresh linked_at.
    const otherGroupId = `atg_rollback_extmove_other_${TS}`
    await query(
      `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1, $2, $3, 2, 'probe')`,
      [otherGroupId, org, 'Ops'],
    )
    await query(
      `UPDATE approval_template_group_links SET group_id = $1, linked_at = now() WHERE org_id = $2 AND template_id = $3`,
      [otherGroupId, org, movedTpl],
    )

    await rollbackApprovalTemplateGroupBackfillBatch(org, result.batchId as string)

    const linkRow = await query<{ group_id: string | null }>(
      `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, movedTpl],
    )
    expect(linkRow.rows[0].group_id).toBe(otherGroupId) // untouched — the stale token did not match, so rollback skipped it

    // The original batch-created group has zero members now (the only member moved away) — §4.3's
    // remaining=0 rule fires legitimately here (this is the group's TRUE current membership, not
    // rollback reaching into batch-external state) and archives it.
    const originalGroupRow = await query<{ archived_at: string | null }>(
      `SELECT archived_at FROM approval_template_groups WHERE id = $1`,
      [originalGroupId],
    )
    expect(originalGroupRow.rows[0].archived_at).not.toBeNull()
  })

  // §4.2's OWN discriminating case, distinct from the "moved to a different group" test above:
  // there, `group_id` alone already differs, so that test cannot tell "the join checks group_id"
  // apart from "the join checks group_id AND linked_at". Here the template is detached and
  // RE-attached to the exact SAME group by a batch-external action — `group_id` matches what the
  // batch recorded, but `linked_at` (the re-attach's own upsert timestamp) does not. Only the
  // `linked_at` half of the token can catch this. Verified with a mutation probe below.
  it('a batch-linked template detached and re-linked to the SAME group by a batch-external action is left alone (a fresh linked_at is a different token, even though group_id is unchanged)', async () => {
    const org = trackOrg(`atgr-extrelink-${TS}`)
    const tpl = await createTemplate(`atgr-extrelink-tpl-${TS}`, 'HR')
    // §11 CI fix: same `result.groups[0]` exposure as the batch-external-move test above — sunk for
    // the same reason (see that test's own comment for the mechanism).
    await sinkForeignTemplates(org, [tpl])
    const result = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(result.batchId).not.toBeNull()
    const groupId = result.groups[0].groupId

    // Batch-external detach + re-attach to the SAME group — a fresh linked_at, same group_id.
    await query(
      `UPDATE approval_template_group_links SET group_id = NULL, unlinked_at = now() WHERE org_id = $1 AND template_id = $2`,
      [org, tpl],
    )
    await query(
      `UPDATE approval_template_group_links SET group_id = $1, unlinked_at = NULL, linked_at = now() WHERE org_id = $2 AND template_id = $3`,
      [groupId, org, tpl],
    )

    await rollbackApprovalTemplateGroupBackfillBatch(org, result.batchId as string)

    const linkRow = await query<{ group_id: string | null }>(
      `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, tpl],
    )
    expect(linkRow.rows[0].group_id).toBe(groupId) // untouched — the re-attach's fresh linked_at did not match the batch's recorded token

    // Still has its one (re-attached) member — remaining > 0 — so §4.3 must NOT archive it, even
    // though the batch-recorded link row was "handled" (skipped, not unlinked).
    const groupRow = await query<{ archived_at: string | null }>(
      `SELECT archived_at FROM approval_template_groups WHERE id = $1`,
      [groupId],
    )
    expect(groupRow.rows[0].archived_at).toBeNull()
  })

  it('changesRequired #7: rolling back an already-rolled-back batch is a 409 (not an idempotent 200), and the error carries the original rolledBackAt', async () => {
    const org = trackOrg(`atgr-double-${TS}`)
    await createTemplate(`atgr-double-tpl-${TS}`, 'HR')
    const executed = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    const batchId = executed.batchId as string

    const first = await rollbackApprovalTemplateGroupBackfillBatch(org, batchId)

    await expect(rollbackApprovalTemplateGroupBackfillBatch(org, batchId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_ALREADY_ROLLED_BACK',
      details: { rolledBackAt: first.rolledBackAt },
    })
  })

  it('a batchId that does not exist (in this org) is a 404, indistinguishable from a batchId belonging to a DIFFERENT org', async () => {
    const org = trackOrg(`atgr-notfound-${TS}`)
    const otherOrg = trackOrg(`atgr-notfound-other-${TS}`)
    await createTemplate(`atgr-notfound-other-tpl-${TS}`, 'HR')
    const executedInOtherOrg = await executeApprovalTemplateGroupBackfill(otherOrg, managerActor, 'probe-actor')
    const foreignBatchId = executedInOtherOrg.batchId as string

    await expect(rollbackApprovalTemplateGroupBackfillBatch(org, 'atgbb_does-not-exist')).rejects.toMatchObject({
      statusCode: 404,
      code: 'APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_NOT_FOUND',
    })
    // Same 404 — org_id is part of the lookup WHERE, not a separate ownership check afterward.
    await expect(rollbackApprovalTemplateGroupBackfillBatch(org, foreignBatchId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_NOT_FOUND',
    })
  })

  describe('route wiring: POST /api/approval-template-groups/backfill/batches/:batchId/rollback (real HTTP, real guard)', () => {
    it('an admin actor gets 200 and the batch-created group becomes archived', async () => {
      const org = trackOrg(`atgr-http-admin-${TS}`)
      await createTemplate(`atgr-http-admin-tpl-${TS}`, 'HTTPRollback')
      const admin = await tok(base, `http-rollback-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

      const execRes = await httpReq(base, '/api/approval-template-groups/backfill/execute', 'POST', admin)
      expect(execRes.status).toBe(201)
      const execBody = (await execRes.json()) as { batchId: string }

      const res = await httpReq(
        base,
        `/api/approval-template-groups/backfill/batches/${execBody.batchId}/rollback`,
        'POST',
        admin,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { rolledBackAt: string }
      expect(typeof body.rolledBackAt).toBe('string')

      const groupRow = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM approval_template_groups WHERE org_id = $1 AND name = 'HTTPRollback' AND archived_at IS NOT NULL`,
        [org],
      )
      expect(Number(groupRow.rows[0].n)).toBe(1)
    })

    it('an actor holding ONLY approvals:read (no approval-templates:manage) gets 403', async () => {
      const org = trackOrg(`atgr-http-reader-${TS}`)
      const reader = await tok(base, `http-rollback-reader-${TS}`, { roles: 'user', perms: 'approvals:read', tenantId: org })

      const res = await httpReq(base, '/api/approval-template-groups/backfill/batches/atgbb_whatever/rollback', 'POST', reader)
      expect(res.status).toBe(403)
    })

    it('an unauthenticated request gets 401, not a silent 200', async () => {
      const res = await fetch(`${base}/api/approval-template-groups/backfill/batches/atgbb_whatever/rollback`, {
        method: 'POST',
      })
      expect(res.status).toBe(401)
    })
  })
})
