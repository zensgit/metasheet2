import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 3 (A-4) real-DB
 * acceptance: C (three-token/four-bucket `section=` listing, per-section pagination) and D (the
 * `category` back-fill bucket). Both are explicitly OUT OF phase 1's scope — the phase-1 normal-
 * pool file's own header says so verbatim ("C and D are OUT OF SCOPE for this slice — the lock's
 * own §6 phase table assigns `section=` (C) and its `category` fallback partner (D) to phase 3"),
 * and this is that phase-3 file. It is its own THIRD `.db.test.ts` for this feature (alongside
 * the phase-1 pair) rather than an addition to either of them, because C/D exercise a read-only
 * path (no L0/L1/L2 — §2 锁序表 "只读路径不取 L0") that needs neither the RR-default pool
 * (`…-serialization.db.test.ts`, E/K) nor the write-path fixtures of the normal-pool file
 * (`…-lifecycle.db.test.ts`, A/A′/A″/A‴/B/B′/B″/F/G/H/I′) — a NORMAL pool, same as the latter.
 *
 * RESIDUAL CLOSED (2026-09-18, same day as disclosure): the missing `*-ci-wiring.test.mjs`
 * closed-world guard for this feature's `.db.test.ts` family now exists —
 * `scripts/ops/approval-template-groups-ci-wiring.test.mjs`, modeled whole on the newer,
 * step-id-anchored `t2-source-freeze-ci-wiring.test.mjs` contract (not the older regex-style
 * `approval-data-closure-ci-wiring.test.mjs`, which cannot detect the "step exists but never runs"
 * bypass class) — covering all four files of this feature (both phase-1 originals and both
 * phase-3 additions), wired into `plugin-tests.yml`'s required no-DB `test` job as its own
 * `node --test` step, with the `pluginTestsWorkflow` s6a pin recomputed in the same commit.
 *
 * Every mutation probe below is a real source-code edit — backed up with `cp`, applied, the ONE
 * affected test re-run to observe red, restored, and `cmp`-verified byte-identical (recorded in
 * the implementation PR's verification notes, not encoded as permanent code here — same
 * convention as the phase-1 siblings).
 *   (1) delete the bucket predicate call in `listApprovalTemplatesBySection` (replace the WHERE
 *       clause with just the org/status/search/visibility conditions) → the four-bucket test's
 *       disjointness assertion fails (every bucket returns the full candidate set, so the same
 *       template id appears in more than one section);
 *   (2) delete the `OR category = ''` half of the `ungrouped` bucket predicate
 *       (`ApprovalTemplateGroupSectionService.ts`'s `buildSectionBucketCondition`, `'ungrouped'`
 *       case) → the empty-string-category fixture template (④, category `''`) drops out of EVERY
 *       section (zero-section, not double-section) — the v2.6 P2-A mutation target;
 *   (3) delete the route's `total: sectioned.total` composition (or, at the service layer, the
 *       `LIMIT`/`OFFSET` clause) → the pagination test's page-2 `data` overlaps page-1's, or the
 *       reported `total` stops matching the section-scoped count.
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

/** Same name/shape as the phase-1 siblings — NOT imported (neither exports it; see their own
 * header notes on why this helper is duplicated rather than shared). */
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

async function httpReq(
  base: string,
  path: string,
  token: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

describeIfDatabase('Approval template groups — §6 phase 3 sections (lock v2.13, acceptance C/D)', () => {
  let server: MetaSheetServer
  let base: string
  const templateIds: string[] = []
  const orgTags: string[] = []

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
      await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org])
    }
    for (const id of templateIds.splice(0)) {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [id])
    }
    await server?.stop()
  })

  async function createTemplate(key: string, category: string | null): Promise<string> {
    const row = await query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, status, visibility_scope, category)
       VALUES ($1, $1, 'draft', $2, $3) RETURNING id`,
      [key, JSON.stringify({ type: 'all', ids: [] }), category],
    )
    const id = row.rows[0].id
    templateIds.push(id)
    return id
  }

  function trackOrg(org: string): string {
    orgTags.push(org)
    return org
  }

  // ── C ──────────────────────────────────────────────────────────────────────────────────────
  it('C: three tokens / four buckets — group:<id> / ungrouped (②+④) / category:<name>, no template in two sections or zero sections', async () => {
    const org = trackOrg(`atg-sec-c-${TS}`)
    const admin = await tok(base, `sec-c-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, {
      method: 'POST',
      body: { name: `Sec C Group ${TS}` },
    })).json()).group

    // ① active link → bucket `group:<id>`.
    const t1 = await createTemplate(`atg-sec-c-t1-${TS}`, null)
    expect((await httpReq(base, `/api/approval-templates/${t1}/group`, admin, {
      method: 'POST',
      body: { groupId: group.id },
    })).status).toBe(201)

    // ② link row exists but unlinked (`group_id IS NULL`) → bucket `ungrouped`.
    const t2 = await createTemplate(`atg-sec-c-t2-${TS}`, null)
    expect((await httpReq(base, `/api/approval-templates/${t2}/group`, admin, {
      method: 'POST',
      body: { groupId: group.id },
    })).status).toBe(201)
    expect((await httpReq(base, `/api/approval-templates/${t2}/group`, admin, { method: 'DELETE' })).status).toBe(204)

    // ③ never linked, non-empty legacy category → bucket `category:<name>`.
    const categoryName = `Sec-Cat-${TS}`
    const t3 = await createTemplate(`atg-sec-c-t3-${TS}`, categoryName)

    // ④ never linked, category is EMPTY STRING (not NULL) → bucket `ungrouped` (v2.6 P2-A: the
    // `OR category = ''` half of the predicate — without it this row falls into ZERO sections).
    const t4 = await createTemplate(`atg-sec-c-t4-${TS}`, '')

    // ④ never linked, category is NULL → also bucket `ungrouped` (the other half of the same OR).
    const t5 = await createTemplate(`atg-sec-c-t5-${TS}`, null)

    const groupSection = await (await httpReq(
      base,
      `/api/approval-templates?section=${encodeURIComponent(`group:${group.id}`)}`,
      admin,
    )).json()
    // `group:<id>` is scoped to a fresh, test-unique group id, so exact equality (not just
    // containment) is safe here — no OTHER test's fixture can ever be linked to this group.
    const groupIds = groupSection.data.map((d: { id: string }) => d.id)
    expect(groupIds).toEqual([t1])
    expect(groupSection.total).toBe(1)

    // `ungrouped` is NOT test-exclusive: `approval_templates` rows are global (no org column,
    // §1), so a category-less template created by a DIFFERENT test earlier in this same file
    // (never linked in THIS org either) legitimately also lands in this org's `ungrouped`
    // bucket — that is the correct cross-org fallback semantics, not pollution. Assert
    // CONTAINMENT of the expected ids and ABSENCE of the wrongly-bucketed ones, not an exact
    // set (the exact set is open-world and run-order-dependent).
    const ungroupedSection = await (await httpReq(base, '/api/approval-templates?section=ungrouped', admin)).json()
    const ungroupedIds = ungroupedSection.data.map((d: { id: string }) => d.id)
    for (const id of [t2, t4, t5]) expect(ungroupedIds).toContain(id)
    expect(ungroupedIds).not.toContain(t1)
    expect(ungroupedIds).not.toContain(t3)

    const categorySection = await (await httpReq(
      base,
      `/api/approval-templates?section=${encodeURIComponent(`category:${categoryName}`)}`,
      admin,
    )).json()
    // `category:<name>` matches on an exact-equality test-unique string — same safety as the
    // group bucket above.
    const categoryIds = categorySection.data.map((d: { id: string }) => d.id)
    expect(categoryIds).toEqual([t3])
    expect(categorySection.total).toBe(1)

    // Disjointness + no-zero-section over the KNOWN candidate set: each of the five fixture ids
    // appears in EXACTLY ONE of the three responses above (membership checks against the full
    // `ungroupedIds` array are unaffected by any extra, unrelated ids it may also contain).
    for (const id of [t1, t2, t3, t4, t5]) {
      const memberships = [groupIds.includes(id), ungroupedIds.includes(id), categoryIds.includes(id)]
        .filter(Boolean).length
      expect(memberships).toBe(1)
    }
  })

  // ── D ──────────────────────────────────────────────────────────────────────────────────────
  it('D: category fallback is scoped to "never had a link row" — NOT "group_id IS NULL" (that is the B′ mutation target, re-run here at the section layer)', async () => {
    const org = trackOrg(`atg-sec-d-${TS}`)
    const admin = await tok(base, `sec-d-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })
    const categoryName = `Sec-D-Cat-${TS}`

    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, {
      method: 'POST',
      body: { name: `Sec D Group ${TS}` },
    })).json()).group

    // Never linked, category set → SHOULD appear under `category:<name>`.
    const neverLinked = await createTemplate(`atg-sec-d-never-${TS}`, categoryName)

    // Linked then unlinked, SAME category value on the row → per I2′ this org's view is
    // "unlinked", not "fall back to category" — must NOT appear under `category:<name>`, only
    // under `ungrouped`.
    const wasLinked = await createTemplate(`atg-sec-d-was-linked-${TS}`, categoryName)
    expect((await httpReq(base, `/api/approval-templates/${wasLinked}/group`, admin, {
      method: 'POST',
      body: { groupId: group.id },
    })).status).toBe(201)
    expect((await httpReq(base, `/api/approval-templates/${wasLinked}/group`, admin, { method: 'DELETE' })).status).toBe(204)

    const categorySection = await (await httpReq(
      base,
      `/api/approval-templates?section=${encodeURIComponent(`category:${categoryName}`)}`,
      admin,
    )).json()
    // Test-unique category string — exact equality is safe (see the C test's own note).
    expect(categorySection.data.map((d: { id: string }) => d.id)).toEqual([neverLinked])

    // `ungrouped` is open-world across tests (see the C test's own note) — assert containment
    // of `wasLinked` and absence of `neverLinked`, not an exact set.
    const ungroupedSection = await (await httpReq(base, '/api/approval-templates?section=ungrouped', admin)).json()
    const ungroupedIds = ungroupedSection.data.map((d: { id: string }) => d.id)
    expect(ungroupedIds).toContain(wasLinked)
    expect(ungroupedIds).not.toContain(neverLinked)
  })

  // ── C (pagination) ────────────────────────────────────────────────────────────────────────
  it('C: pagination is scoped to the section — total is this bucket\'s own count, pages do not overlap or drop rows', async () => {
    const org = trackOrg(`atg-sec-page-${TS}`)
    const admin = await tok(base, `sec-page-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })
    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, {
      method: 'POST',
      body: { name: `Sec Page Group ${TS}` },
    })).json()).group

    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const id = await createTemplate(`atg-sec-page-t${i}-${TS}`, null)
      expect((await httpReq(base, `/api/approval-templates/${id}/group`, admin, {
        method: 'POST',
        body: { groupId: group.id },
      })).status).toBe(201)
      ids.push(id)
    }
    // One control row OUTSIDE the group (a different, unrelated section) — proves `total` below
    // is section-scoped, not the org's whole-template count.
    await createTemplate(`atg-sec-page-outside-${TS}`, null)

    const sectionToken = encodeURIComponent(`group:${group.id}`)
    const seen: string[] = []
    let total = -1
    for (const page of [1, 2, 3]) {
      const resp = await (await httpReq(
        base,
        `/api/approval-templates?section=${sectionToken}&page=${page}&pageSize=2`,
        admin,
      )).json()
      total = resp.total
      seen.push(...resp.data.map((d: { id: string }) => d.id))
    }

    expect(total).toBe(5)
    expect(new Set(seen).size).toBe(5) // no page repeated a row
    expect(new Set(seen)).toEqual(new Set(ids)) // and no row was dropped
  })

  // ── C / J (request-shape 400s, moved up from A-1/A-2 per the supplementary gate checklist) ──
  it('C/J: malformed section requests are rejected 400 before any DB access', async () => {
    const org = trackOrg(`atg-sec-400-${TS}`)
    const admin = await tok(base, `sec-400-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    const conflict = await httpReq(base, '/api/approval-templates?section=ungrouped&category=whatever', admin)
    expect(conflict.status).toBe(400)
    expect((await conflict.json()).error.code).toBe('APPROVAL_TEMPLATE_SECTION_CATEGORY_CONFLICT')

    const unknownToken = await httpReq(base, '/api/approval-templates?section=not-a-real-token', admin)
    expect(unknownToken.status).toBe(400)
    expect((await unknownToken.json()).error.code).toBe('APPROVAL_TEMPLATE_SECTION_TOKEN_INVALID')

    const emptyToken = await httpReq(base, '/api/approval-templates?section=', admin)
    expect(emptyToken.status).toBe(400)
    expect((await emptyToken.json()).error.code).toBe('APPROVAL_TEMPLATE_SECTION_TOKEN_INVALID')

    // Repeated `section=` query key parses to an ARRAY, not a string — must not silently
    // fall through to the unsectioned list.
    const repeated = await httpReq(base, '/api/approval-templates?section=ungrouped&section=group:x', admin)
    expect(repeated.status).toBe(400)
    expect((await repeated.json()).error.code).toBe('APPROVAL_TEMPLATE_SECTION_TOKEN_INVALID')

    // A repeated `?category=` key ALSO parses to an ARRAY (Express query-string parsing is
    // symmetric across keys), so the category-conflict check must recognize it the same way the
    // section-token check recognizes a repeated `section=` above — `isOrgIdValuePresent`
    // (routes/approvals.ts) is the shared helper, also used for the `orgId` body/query rejection,
    // and this pins that its array branch actually reaches this call site rather than being
    // reachable only from `resolveApprovalTemplateGroupOrgId`'s own callers.
    const arrayCategory = await httpReq(
      base,
      '/api/approval-templates?section=ungrouped&category=a&category=b',
      admin,
    )
    expect(arrayCategory.status).toBe(400)
    expect((await arrayCategory.json()).error.code).toBe('APPROVAL_TEMPLATE_SECTION_CATEGORY_CONFLICT')

    // Positive control: a well-formed, non-conflicting request succeeds.
    const ok = await httpReq(base, '/api/approval-templates?section=ungrouped', admin)
    expect(ok.status).toBe(200)
  })
})
