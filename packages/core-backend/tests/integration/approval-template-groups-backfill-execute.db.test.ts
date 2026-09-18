import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'
import { executeApprovalTemplateGroupBackfill } from '../../src/routes/approvals'
import { classifyBackfillCategory } from '../../src/services/ApprovalTemplateGroupService'
import type { ApprovalTemplateVisibilityActor } from '../../src/services/ApprovalProductService'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3 ("backfill
 * by existing category") — real-DB acceptance for **W8 execute** (`executeApprovalTemplateGroupBackfill`
 * in `src/routes/approvals.ts`, `docs/development/approval-template-groups-phase2-backfill-design-20260918.md`
 * §3 / §13.2). W9 rollback is a separate unit with its own dedicated
 * `approval-template-groups-backfill-rollback.db.test.ts` file and is not otherwise exercised here.
 *
 * This is the FIRST real-DB coverage of the §13.2 unified lock order's "pre-lock every existing
 * group, ORDER BY id FOR UPDATE" statement and of a single `transaction()` callback composing
 * TWO `...WithClient` primitives (`createApprovalTemplateGroupWithClient` /
 * `linkApprovalTemplateToGroupWithClient`) on one connection — design-gate §13.1 changesRequired
 * #13's THREE combined-call discriminating tests (concurrent-execute L0 parking with a reverse
 * positive control, the RR-pool SET-obligation test, and a stopped-at-the-lock assertion rather
 * than an outcome assertion) are explicitly DEFERRED to a follow-up commit on this same branch —
 * the design-gate report's "同 PR" obligation names a PR, not this commit, and this branch has
 * not opened one yet. What THIS file covers instead: the happy-path create/attach shapes, the
 * §13 changesRequired #3 mechanism (storable-predicate-inside-SQL, not a loop `continue`) against
 * a MIXED eligible/skip population in the same call, sequential-call idempotency across every
 * table execute can write, the classifyBackfillCategory/SQL-predicate cross-verification §15
 * explicitly deferred to this unit, and the changesRequired #2 "linked_at never through JS" claim
 * verified as a raw SQL equality (not JS `toISOString()` equality, which would pass even under the
 * pre-fix bug design-gate M4 found).
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

// Copied (not imported) from the sibling preview suite, itself copied from
// `approval-template-groups-lifecycle.db.test.ts` — same convention, no new shared export surface.
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

describeIfDatabase('approval template groups — phase 2 backfill execute (W8, design-gate A3-phase2 §3)', () => {
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

  // Same rationale as the preview suite's own `afterEach`: `approval_templates` carries no org
  // column, so a template left linked-nowhere by one case stays an eligible candidate for every
  // later case in this file.
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

  async function createGroup(id: string, org: string, name: string): Promise<void> {
    await query(
      `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1, $2, $3, 1, 'probe')`,
      [id, org, name],
    )
  }

  const managerActor: ApprovalTemplateVisibilityActor = {
    userId: `execute-manager-${TS}`,
    departmentIds: [],
    roles: [],
    permissions: [],
    isTemplateManager: true,
  }

  interface OrgTableCounts {
    groups: number
    links: number
    batches: number
    batchGroups: number
    batchLinks: number
  }

  async function tableCounts(org: string): Promise<OrgTableCounts> {
    async function count(sql: string): Promise<number> {
      const result = await query<{ n: string }>(sql, [org])
      return Number(result.rows[0].n)
    }
    return {
      groups: await count(`SELECT count(*)::text AS n FROM approval_template_groups WHERE org_id = $1`),
      links: await count(`SELECT count(*)::text AS n FROM approval_template_group_links WHERE org_id = $1 AND group_id IS NOT NULL`),
      batches: await count(`SELECT count(*)::text AS n FROM approval_template_group_backfill_batches WHERE org_id = $1`),
      batchGroups: await count(`SELECT count(*)::text AS n FROM approval_template_group_backfill_batch_groups WHERE org_id = $1`),
      batchLinks: await count(`SELECT count(*)::text AS n FROM approval_template_group_backfill_batch_links WHERE org_id = $1`),
    }
  }

  it('happy path: creates one group per distinct btrim(category), links every eligible template, and records the batch header + both detail tables', async () => {
    const org = trackOrg(`atge-happy-${TS}`)
    const hr1 = await createTemplate(`atge-hr1-${TS}`, 'HR')
    const hr2 = await createTemplate(`atge-hr2-${TS}`, 'HR')
    const finance = await createTemplate(`atge-fin-${TS}`, 'Finance')

    const result = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')

    expect(result.batchId).not.toBeNull()
    expect(result.scope).toBe('org-complete')
    const hrGroup = result.groups.find((g) => g.category === 'HR')
    expect(hrGroup?.action).toBe('create')
    expect(new Set(hrGroup?.templateIds)).toEqual(new Set([hr1, hr2]))
    const financeGroup = result.groups.find((g) => g.category === 'Finance')
    expect(financeGroup?.action).toBe('create')
    expect(financeGroup?.templateIds).toEqual([finance])

    const counts = await tableCounts(org)
    expect(counts).toEqual({ groups: 2, links: 3, batches: 1, batchGroups: 2, batchLinks: 3 })

    const batchRow = await query<{ created_by: string; org_id: string }>(
      `SELECT created_by, org_id FROM approval_template_group_backfill_batches WHERE id = $1`,
      [result.batchId],
    )
    expect(batchRow.rows[0]).toEqual({ created_by: 'probe-actor', org_id: org })

    const batchGroupRows = await query<{ created_new: boolean }>(
      `SELECT created_new FROM approval_template_group_backfill_batch_groups WHERE batch_id = $1`,
      [result.batchId],
    )
    expect(batchGroupRows.rows.every((r) => r.created_new === true)).toBe(true)
  })

  it('attach path: an existing active group whose name matches btrim(category) is attached (created_new=false), no second group is created', async () => {
    const org = trackOrg(`atge-attach-${TS}`)
    const existingGroupId = `atg_execute_attach_${TS}`
    await createGroup(existingGroupId, org, 'HR')
    const tpl = await createTemplate(`atge-attach-tpl-${TS}`, '  HR  ') // btrim('  HR  ') = 'HR'

    const result = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')

    expect(result.batchId).not.toBeNull()
    const hrGroup = result.groups.find((g) => g.category === 'HR')
    expect(hrGroup?.action).toBe('attach')
    expect(hrGroup?.groupId).toBe(existingGroupId)
    expect(hrGroup?.templateIds).toEqual([tpl])

    // Exactly the pre-existing row — execute must NOT have inserted a second 'HR' group.
    const groupCount = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_groups WHERE org_id = $1`,
      [org],
    )
    expect(Number(groupCount.rows[0].n)).toBe(1)

    const batchGroupRow = await query<{ created_new: boolean; group_id: string }>(
      `SELECT created_new, group_id FROM approval_template_group_backfill_batch_groups WHERE batch_id = $1`,
      [result.batchId],
    )
    expect(batchGroupRow.rows).toEqual([{ created_new: false, group_id: existingGroupId }])
  })

  // §13 changesRequired #3's exact mechanism claim: the storable-name predicate must live INSIDE
  // the `eligible` SQL query, not a per-row loop `continue` — otherwise an ineligible row still
  // satisfies `NOT EXISTS`, `eligible` is never empty, and (pre-fix) the WHOLE call would either
  // never take the "batchId: null" branch or (worse, pre-fix behaviour) the whole transaction
  // would throw on the CJK row's CHECK violation and roll back the ASCII bucket too. This fixture
  // mixes one skip-eligible (CJK) template with one eligible (ASCII) template in the SAME org/call
  // specifically to prove the skip does not block the eligible bucket.
  it('a non-storable category (pure CJK) is skipped — no group/link/batch row for it — while a co-resident eligible category in the SAME call still succeeds', async () => {
    const org = trackOrg(`atge-mixed-skip-${TS}`)
    const cjkTpl = await createTemplate(`atge-cjk-${TS}`, '人事')
    const hrTpl = await createTemplate(`atge-mixed-hr-${TS}`, 'HR')

    const result = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')

    expect(result.batchId).not.toBeNull() // NOT null — the HR bucket alone must still commit a batch
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ category: 'HR', action: 'create', templateIds: [hrTpl] })

    const cjkLink = await query<{ group_id: string | null }>(
      `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, cjkTpl],
    )
    expect(cjkLink.rows).toHaveLength(0) // never touched — no row at all, not even a null-group row

    const cjkGroup = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_groups WHERE org_id = $1 AND name = $2`,
      [org, '人事'],
    )
    expect(Number(cjkGroup.rows[0].n)).toBe(0)
  })

  // An org where EVERY candidate is skip-eligible must still commit zero rows and report
  // batchId: null — the pre-changesRequired-#3 failure mode this pins against is "eligible is
  // never actually empty because skip was a loop continue", which would otherwise insert one
  // batch-header row per call even though nothing was ever backfillable.
  it('an org where every candidate is skip-eligible writes zero rows and reports batchId: null (not an empty-but-committed batch)', async () => {
    const org = trackOrg(`atge-all-skip-${TS}`)
    await createTemplate(`atge-all-skip-cjk-${TS}`, '人事')
    await createTemplate(`atge-all-skip-blank-${TS}`, '   ')

    const result = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')

    expect(result).toEqual({ batchId: null, scope: 'org-complete', groups: [] })
    const counts = await tableCounts(org)
    expect(counts).toEqual({ groups: 0, links: 0, batches: 0, batchGroups: 0, batchLinks: 0 })
  })

  // §3.2 "两次顺序 execute 幂等" — the SAME code path a concurrent loser takes (see design doc
  // §3.2), asserted here as the sequential leg. Zero row delta is checked across EVERY table
  // execute can write, not just the response shape: a response-only assertion would stay green
  // even if the second call silently duplicated batch bookkeeping rows for the same links.
  it('idempotency: a second sequential execute call on the same eligible population returns batchId: null and writes zero additional rows across every table', async () => {
    const org = trackOrg(`atge-idem-${TS}`)
    await createTemplate(`atge-idem-hr1-${TS}`, 'HR')
    await createTemplate(`atge-idem-hr2-${TS}`, 'HR')

    const first = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(first.batchId).not.toBeNull()
    const countsAfterFirst = await tableCounts(org)

    const second = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(second).toEqual({ batchId: null, scope: 'org-complete', groups: [] })

    const countsAfterSecond = await tableCounts(org)
    expect(countsAfterSecond).toEqual(countsAfterFirst)
  })

  // §13 changesRequired #2, "令牌全程不经 JS": a raw SQL equality between the two tables' own
  // `linked_at` columns, NOT a JS `Date`/`toISOString()` comparison — the pre-fix bug (design-gate
  // M4) had `mapLinkRow`'s millisecond-truncated JS string compare EQUAL to itself while the two
  // real `timestamptz` columns disagreed at microsecond precision; only a comparison performed
  // entirely inside Postgres can see that.
  it("changesRequired #2: approval_template_group_backfill_batch_links.linked_at is byte-identical (raw SQL '=', not JS) to the links row it was copied from", async () => {
    const org = trackOrg(`atge-token-${TS}`)
    await createTemplate(`atge-token-hr1-${TS}`, 'HR')
    await createTemplate(`atge-token-hr2-${TS}`, 'HR')

    const result = await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')
    expect(result.batchId).not.toBeNull()

    const rows = await query<{ eq: boolean }>(
      `SELECT (l.linked_at = b.linked_at) AS eq
         FROM approval_template_group_backfill_batch_links b
         JOIN approval_template_group_links l ON l.org_id = b.org_id AND l.template_id = b.template_id
        WHERE b.batch_id = $1`,
      [result.batchId],
    )
    expect(rows.rows.length).toBe(2) // both HR templates must be present, not just non-empty
    expect(rows.rows.every((r) => r.eq === true)).toBe(true)
  })

  // §15's explicitly-deferred obligation, discharged here: `classifyBackfillCategory`
  // (`ApprovalTemplateGroupService.ts`, a pure JS reimplementation of Postgres's one-argument
  // `btrim` + the `[!-~]` storability class) must agree, ROW BY ROW against this unit's OWN SQL
  // `eligible` predicate, with which of these real candidate rows execute actually processed —
  // not a separately-run ad hoc SQL query, but the outcome of the real call this file exercises.
  // Collation caveat: this suite runs against whatever Postgres collation the local/CI DB was
  // initialized with (glibc/`en_US.utf8` in every environment this has been run in so far). It
  // does not exercise the musl/`15-alpine` collation axis production uses — see
  // `STORABLE_GROUP_NAME_PATTERN`'s doc-comment (ApprovalTemplateGroupService.ts) for why that axis
  // is a distinct, unverified risk (`finding_prod_pg15_never_tested`), not covered by this test
  // being green.
  it('SQL/JS cross-verification: classifyBackfillCategory.action==="skip" agrees, per real candidate row, with whether execute left that row unlinked', async () => {
    const org = trackOrg(`atge-crossverify-${TS}`)
    const fixtures: Array<{ key: string; category: string | null }> = [
      { key: 'ascii', category: 'Ops' },
      { key: 'padded', category: '  Ops  ' }, // btrim -> 'Ops', same bucket as 'ascii'
      { key: 'cjk', category: '人事' },
      { key: 'blank', category: '   ' },
      { key: 'null', category: null },
    ]
    const idByKey = new Map<string, string>()
    for (const f of fixtures) {
      idByKey.set(f.key, await createTemplate(`atge-xv-${f.key}-${TS}`, f.category))
    }

    await executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')

    for (const f of fixtures) {
      const classification = classifyBackfillCategory(f.category, new Map())
      const linked = await query<{ group_id: string | null }>(
        `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
        [org, idByKey.get(f.key)],
      )
      const wasLinked = linked.rows.length > 0 && linked.rows[0].group_id !== null
      expect(wasLinked).toBe(classification.action !== 'skip')
    }
  })

  // §13 changesRequired #12 / design-gate A3-phase2 extra P2 ("execute 规模上界"), real-DB half —
  // the `.ts` guard itself (`eligible.length > APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES`,
  // `routes/approvals.ts:626-632`) landed in the W8 commit but §19.1/§19.4 record its real-DB
  // coverage as still open ("超 500 触发 400、零行写入 仍未覆盖"). Two independent template rows
  // do not exist per candidate here — `approval_templates` carries no `org_id` column at all (see
  // this file's own `afterEach` comment), so "eligible" is a GLOBAL count across the whole table,
  // not scoped to this test's `org`. A bulk `generate_series` INSERT (one round trip, not 501
  // separate `createTemplate()` calls) creates 550 fresh rows — comfortably over the 500 cap even
  // if a prior test in this run left stray eligible rows behind, and NOT tracked in the shared
  // `templateIds` array (which the file's `afterEach` drains one-row-at-a-time — 550 individual
  // DELETEs there would slow every other test in this file) — this test deletes its own batch by
  // key prefix in a `finally`, so a thrown assertion still cleans up and does not poison later
  // tests' global eligible counts. This isolation relies on the file's cases running sequentially
  // (the default here, no `it.concurrent`) — a sibling case executing DURING this test's 550-row
  // window would itself see `eligible > 500` for any org it exercises, or pick up a `CapProbe`
  // group it does not expect; this is a disclosure, not something this test defends against.
  //
  // The 400's message asserts the LITERAL "500" (via `MAX_CANDIDATES` reused into the regex, not
  // a second hardcoded "500") on top of the statusCode/code — `APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES`
  // is not exported, so nothing else ties this test's fixture size to the guard's real threshold.
  // Without the message check, lowering the constant (leaving 550 still over whatever the new
  // value is) would keep this test green while it silently stopped proving anything about the
  // number 500 specifically — the message is the only channel the real threshold is observable
  // through from outside the module.
  const MAX_CANDIDATES_UNDER_TEST = 500 // must equal `routes/approvals.ts`'s (unexported) `APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES`
  it('§13 changesRequired #12: exceeding the 500-candidate cap throws a typed 400 BEFORE any write commits — zero rows across every table this call could have written', async () => {
    const org = trackOrg(`atge-cap-${TS}`)
    const keyPrefix = `atge-cap-tpl-${TS}-`
    const overCapCount = MAX_CANDIDATES_UNDER_TEST + 50 // margin above the cap, independent of any stray eligible rows
    await query(
      `INSERT INTO approval_templates (key, name, status, category)
       SELECT $1 || g, $1 || g, 'draft', 'CapProbe' FROM generate_series(1, $2) AS g`,
      [keyPrefix, overCapCount],
    )
    try {
      await expect(executeApprovalTemplateGroupBackfill(org, managerActor, 'probe-actor')).rejects.toMatchObject({
        statusCode: 400,
        code: 'APPROVAL_TEMPLATE_GROUP_BACKFILL_TOO_LARGE',
        message: expect.stringContaining(`exceeds the ${MAX_CANDIDATES_UNDER_TEST} limit`),
      })

      // Zero rows written for THIS org across every table the happy path would have touched —
      // the guard fires before the batch-header INSERT, so this is not merely "the transaction
      // rolled back" (which every other error path in this file also exercises) but specifically
      // "nothing was ever written for the org that tripped the cap".
      const counts = await tableCounts(org)
      expect(counts).toEqual({ groups: 0, links: 0, batches: 0, batchGroups: 0, batchLinks: 0 })
    } finally {
      // Not routed through `templateIds`/the shared `afterEach` — one bulk DELETE, so a failed
      // assertion above still removes these rows before the next test's `eligible` count runs.
      await query(`DELETE FROM approval_templates WHERE key LIKE $1`, [`${keyPrefix}%`])
    }
  })

  // Route wiring — real HTTP, real guard, real MetaSheetServer (a path string in source proves
  // nothing about what actually answers it at runtime). Unlike preview, execute's guard is NOT a
  // disclosed I7 deviation (it is a write endpoint, so `approvalTemplateAdminGuard` is I7's own
  // literal rule) — this block exists to prove the route is actually mounted and actually invokes
  // the real service function, not to re-litigate the guard choice.
  describe('route wiring: POST /api/approval-template-groups/backfill/execute (real HTTP, real guard)', () => {
    it('an admin actor gets 200/201 with a batchId and the created group is visible in a follow-up read', async () => {
      const org = trackOrg(`atge-http-admin-${TS}`)
      await createTemplate(`atge-http-admin-tpl-${TS}`, 'HTTPRoute')
      const admin = await tok(base, `http-exec-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

      const res = await httpReq(base, '/api/approval-template-groups/backfill/execute', 'POST', admin)
      expect(res.status).toBe(201)
      const body = (await res.json()) as { batchId: string | null; groups: Array<{ category: string }> }
      expect(body.batchId).not.toBeNull()
      expect(body.groups.some((g) => g.category === 'HTTPRoute')).toBe(true)

      const groupRow = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM approval_template_groups WHERE org_id = $1 AND name = 'HTTPRoute'`,
        [org],
      )
      expect(Number(groupRow.rows[0].n)).toBe(1)
    })

    it('an actor holding ONLY approvals:read (no approval-templates:manage) gets 403', async () => {
      const org = trackOrg(`atge-http-reader-${TS}`)
      const reader = await tok(base, `http-exec-reader-${TS}`, { roles: 'user', perms: 'approvals:read', tenantId: org })

      const res = await httpReq(base, '/api/approval-template-groups/backfill/execute', 'POST', reader)
      expect(res.status).toBe(403)
    })

    it('an unauthenticated request gets 401, not a silent 200', async () => {
      const res = await fetch(`${base}/api/approval-template-groups/backfill/execute`, { method: 'POST' })
      expect(res.status).toBe(401)
    })
  })
})
