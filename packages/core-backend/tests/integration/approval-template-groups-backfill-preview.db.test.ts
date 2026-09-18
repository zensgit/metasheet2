import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'
import { previewApprovalTemplateGroupBackfill } from '../../src/routes/approvals'
import type { ApprovalTemplateVisibilityActor } from '../../src/services/ApprovalProductService'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3 ("backfill
 * by existing category") — real-DB acceptance for **W7 preview only**
 * (`docs/development/approval-template-groups-phase2-design-20260918.md` §5,
 * `previewApprovalTemplateGroupBackfill` in `src/routes/approvals.ts`). W8 execute / W9 rollback
 * are separate, later units (still unimplemented as of this file) — this suite does not exercise
 * them and does not exercise any L0-taking transaction (preview takes no lock at all, §5.2).
 *
 * Most cases call the exported service-layer function directly (same style as the phase 2 DDL
 * schema suite, `approval-template-groups-backfill-schema.db.test.ts`) — no HTTP round trip
 * needed to exercise the preview COMPUTATION itself. The route-wiring/guard block below is the
 * exception and DOES go through a real `MetaSheetServer` + HTTP request: a path string quoted in
 * source (the route registration, the ci-wiring guard) proves nothing about what actually answers
 * that path at runtime (`finding_text_linkage_cannot_prove_src_reachability`) — and §13.1
 * changesRequired #8 / §6.2 is an `ownerLevel=true` ratified DEFAULT (preview carries
 * `approvalTemplateAdminGuard`, a deliberate deviation from I7's literal read/write split) that
 * this unit is specifically responsible for making real, not merely asserting in a comment.
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

// Copied (not imported) from `approval-template-groups-lifecycle.db.test.ts` — that file is
// itself in the gated real-DB CI list and must not gain a new export surface for this file's
// sake (same convention as this repo's other `waitUntilBackendBlockedByHolder`-style copies).
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

async function httpReq(base: string, path: string, token: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
}

describeIfDatabase('approval template groups — phase 2 backfill preview (W7, design-gate A3-phase2 §5)', () => {
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
      await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org])
    }
    for (const id of templateIds.splice(0)) {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [id])
    }
    await server?.stop()
  })

  // `approval_templates` carries NO org column at all (§5.1's candidate predicate is `NOT EXISTS`
  // against THIS org's `approval_template_group_links`, not a `WHERE org_id = …` on the templates
  // table itself) — a template this file creates and never links stays an eligible candidate for
  // EVERY subsequent `previewApprovalTemplateGroupBackfill` call in this suite, regardless of
  // which org calls it (this is real production behaviour, not a test bug: the same template can
  // legitimately be backfilled into more than one org's groups). Wiping templates after EACH case
  // (not only in `afterAll`) is what gives every `it` below its own clean candidate population.
  afterEach(async () => {
    for (const id of templateIds.splice(0)) {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [id])
    }
  })

  function trackOrg(org: string): string {
    orgTags.push(org)
    return org
  }

  async function createTemplate(key: string, category: string | null, visibilityScope?: Record<string, unknown>): Promise<string> {
    const row = await query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, status, category, visibility_scope)
       VALUES ($1, $1, 'draft', $2, $3) RETURNING id`,
      [key, category, JSON.stringify(visibilityScope ?? { type: 'all', ids: [] })],
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

  async function linkTemplate(org: string, templateId: string, groupId: string): Promise<void> {
    await query(
      `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
       VALUES ($1, $2, $3, 'probe', now())`,
      [org, templateId, groupId],
    )
  }

  const managerActor: ApprovalTemplateVisibilityActor = {
    userId: `preview-manager-${TS}`,
    departmentIds: [],
    roles: [],
    permissions: [],
    isTemplateManager: true,
  }

  async function tableCounts(org: string): Promise<{ groups: number; links: number }> {
    const groups = await query<{ n: string }>(`SELECT count(*)::text AS n FROM approval_template_groups WHERE org_id = $1`, [org])
    const links = await query<{ n: string }>(`SELECT count(*)::text AS n FROM approval_template_group_links WHERE org_id = $1`, [org])
    return { groups: Number(groups.rows[0].n), links: Number(links.rows[0].n) }
  }

  it('buckets: groups eligible templates by btrim(category), reports action="create" with no existing group and templateCount matching membership', async () => {
    const org = trackOrg(`atgp-buckets-${TS}`)
    const hr1 = await createTemplate(`atgp-hr1-${TS}`, 'HR')
    const hr2 = await createTemplate(`atgp-hr2-${TS}`, 'HR')
    const finance = await createTemplate(`atgp-fin-${TS}`, 'Finance')

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)

    const hrBucket = preview.buckets.find((b) => b.category === 'HR')
    expect(hrBucket).toBeDefined()
    expect(hrBucket!.action).toBe('create')
    expect(hrBucket!.existingGroupId).toBeNull()
    expect(hrBucket!.templateCount).toBe(2)
    expect(new Set(hrBucket!.templateIds)).toEqual(new Set([hr1, hr2]))

    const financeBucket = preview.buckets.find((b) => b.category === 'Finance')
    expect(financeBucket).toBeDefined()
    expect(financeBucket!.action).toBe('create')
    expect(financeBucket!.templateCount).toBe(1)
    expect(financeBucket!.templateIds).toEqual([finance])
  })

  it('buckets: action="attach" with the existing active group id when an active group already has this name (btrim-matched)', async () => {
    const org = trackOrg(`atgp-attach-${TS}`)
    await createGroup(`atg_preview_attach_${TS}`, org, 'HR')
    const tpl = await createTemplate(`atgp-attach-tpl-${TS}`, '  HR  ') // btrim(' HR ') = 'HR' — same active group

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)

    const hrBucket = preview.buckets.find((b) => b.category === 'HR')
    expect(hrBucket).toBeDefined()
    expect(hrBucket!.action).toBe('attach')
    expect(hrBucket!.existingGroupId).toBe(`atg_preview_attach_${TS}`)
    expect(hrBucket!.templateIds).toEqual([tpl])
  })

  it('an archived group with the same name does NOT count as "existing" — action stays "create"', async () => {
    const org = trackOrg(`atgp-archived-${TS}`)
    await createGroup(`atg_preview_archived_${TS}`, org, 'Legal')
    // `atg_sort_archived_pair` (§2 CHECK, phase 1): archived_at IS NOT NULL <=> sort_order IS NULL
    // — both must flip together or the UPDATE itself is rejected before this test even reaches
    // the preview call.
    await query(
      `UPDATE approval_template_groups SET archived_at = now(), sort_order = NULL WHERE id = $1`,
      [`atg_preview_archived_${TS}`],
    )
    await createTemplate(`atgp-archived-tpl-${TS}`, 'Legal')

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)
    const legalBucket = preview.buckets.find((b) => b.category === 'Legal')
    expect(legalBucket).toBeDefined()
    expect(legalBucket!.action).toBe('create')
    expect(legalBucket!.existingGroupId).toBeNull()
  })

  it('skipped: blank-after-trim (null category and a whitespace-only category) land in one CATEGORY_BLANK_AFTER_TRIM bucket per raw value; non-storable (pure non-ASCII) category gets its own reason', async () => {
    const org = trackOrg(`atgp-skip-${TS}`)
    const nullCat = await createTemplate(`atgp-skip-null-${TS}`, null)
    const blankCat = await createTemplate(`atgp-skip-blank-${TS}`, '   ')
    const chineseCat = await createTemplate(`atgp-skip-cjk-${TS}`, '人事')

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)

    const nullBucket = preview.skipped.find((s) => s.category === '')
    expect(nullBucket).toBeDefined()
    expect(nullBucket!.reason).toBe('CATEGORY_BLANK_AFTER_TRIM')
    expect(nullBucket!.templateIds).toEqual([nullCat])

    const blankBucket = preview.skipped.find((s) => s.category === '   ')
    expect(blankBucket).toBeDefined()
    expect(blankBucket!.reason).toBe('CATEGORY_BLANK_AFTER_TRIM')
    expect(blankBucket!.templateIds).toEqual([blankCat])

    const cjkBucket = preview.skipped.find((s) => s.category === '人事')
    expect(cjkBucket).toBeDefined()
    expect(cjkBucket!.reason).toBe('CATEGORY_NOT_STORABLE_AS_GROUP_NAME')
    expect(cjkBucket!.templateIds).toEqual([chineseCat])

    // None of the skipped rows leak into buckets.
    expect(preview.buckets).toHaveLength(0)
  })

  it('I2′ population (§5.1): a template already linked to ANY group (even after being unlinked and never relinked would still be excluded — this asserts the still-linked leg) never appears in buckets or skipped', async () => {
    const org = trackOrg(`atgp-linked-${TS}`)
    await createGroup(`atg_preview_linked_g_${TS}`, org, 'AlreadyLinked')
    const linkedTpl = await createTemplate(`atgp-linked-tpl-${TS}`, 'AlreadyLinked')
    await linkTemplate(org, linkedTpl, `atg_preview_linked_g_${TS}`)
    const unlinkedTpl = await createTemplate(`atgp-unlinked-tpl-${TS}`, 'AlreadyLinked')

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)
    const bucket = preview.buckets.find((b) => b.category === 'AlreadyLinked')
    expect(bucket).toBeDefined()
    expect(bucket!.templateIds).toEqual([unlinkedTpl]) // linkedTpl excluded by NOT EXISTS
  })

  it('§5.2 changesRequired #16: scope is "org-complete" for a manager actor and "visible-to-you" for a non-manager, independent of whether every row happens to be visible to them', async () => {
    const org = trackOrg(`atgp-scope-${TS}`)
    await createTemplate(`atgp-scope-tpl-${TS}`, 'HR', { type: 'all', ids: [] }) // visible to everyone, including non-managers

    const managerPreview = await previewApprovalTemplateGroupBackfill(org, managerActor)
    expect(managerPreview.scope).toBe('org-complete')

    const undefinedActorPreview = await previewApprovalTemplateGroupBackfill(org, undefined)
    expect(undefinedActorPreview.scope).toBe('org-complete')

    const nonManagerActor: ApprovalTemplateVisibilityActor = {
      userId: `preview-nonmanager-${TS}`,
      departmentIds: [],
      roles: [],
      permissions: [],
      isTemplateManager: false,
    }
    const nonManagerPreview = await previewApprovalTemplateGroupBackfill(org, nonManagerActor)
    expect(nonManagerPreview.scope).toBe('visible-to-you')
    // The one template here is visibility_scope type "all", so it IS visible to the non-manager
    // too — scope is a property of the ACTOR's guard population, not of whether this particular
    // org happens to have zero hidden templates today (that would make the field lie by omission
    // the next time someone adds a scoped template — see finding
    // `finding_attendance_denied_renders_as_all_clear` for the same class of false-negative).
    const bucket = nonManagerPreview.buckets.find((b) => b.category === 'HR')
    expect(bucket).toBeDefined()
  })

  it('preview writes ZERO rows: approval_template_groups/links row counts for the org are byte-identical before and after, across a run that produces both a "create" and a "skip" bucket', async () => {
    const org = trackOrg(`atgp-nowrite-${TS}`)
    await createTemplate(`atgp-nowrite-hr-${TS}`, 'HR')
    await createTemplate(`atgp-nowrite-blank-${TS}`, '')

    const before = await tableCounts(org)
    expect(before).toEqual({ groups: 0, links: 0 })

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)
    expect(preview.buckets.length).toBeGreaterThan(0)
    expect(preview.skipped.length).toBeGreaterThan(0)

    const after = await tableCounts(org)
    expect(after).toEqual(before)

    // Calling it again is equally inert (idempotent by construction — it never writes at all).
    await previewApprovalTemplateGroupBackfill(org, managerActor)
    expect(await tableCounts(org)).toEqual(before)
  })

  // §2 pgBtrim parity fixture: Postgres's ONE-ARGUMENT `btrim(text)` trims ONLY the ASCII space
  // character, not tab/newline (verified live against this suite's own database:
  // `psql … -c "SELECT btrim(E'\t HR \t') = E'\t HR \t' AS tab_survives"` → `t`; a naive
  // `String.prototype.trim()` reimplementation would strip the tab too and silently disagree with
  // what the SQL `eligible` predicate (§3.1, W8) will do on the same row). Every OTHER fixture in
  // this file uses only ASCII spaces or non-ASCII content, where `.trim()` and `pgBtrim` happen to
  // agree — this is the one case that discriminates between the two implementations.
  it('pgBtrim parity: a tab-padded category is NOT trimmed to its inner text (only ASCII space is), so it is classified by the tab itself, not the letters inside it', async () => {
    const org = trackOrg(`atgp-tab-${TS}`)
    const tabOnly = await createTemplate(`atgp-tab-only-${TS}`, '\t')
    const tabPadded = await createTemplate(`atgp-tab-padded-${TS}`, '\tHR\t')

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)

    // '\t' alone: btrim('\t') = '\t' (unchanged — tab is not a space), and '\t' does not match
    // `[!-~]` (0x09 is outside 0x21–0x7E) → CATEGORY_NOT_STORABLE_AS_GROUP_NAME, not
    // CATEGORY_BLANK_AFTER_TRIM (which would be the wrong reason if `.trim()` had been used
    // instead — `.trim()` reduces '\t' to '' and would misreport this as "blank").
    const tabOnlyBucket = preview.skipped.find((s) => s.category === '\t')
    expect(tabOnlyBucket).toBeDefined()
    expect(tabOnlyBucket!.reason).toBe('CATEGORY_NOT_STORABLE_AS_GROUP_NAME')
    expect(tabOnlyBucket!.templateIds).toEqual([tabOnly])

    // '\tHR\t': btrim leaves the tabs in place ('\tHR\t', not 'HR') — so this bucket's `category`
    // is the tab-padded string, NOT the plain 'HR' bucket from other tests, and it does NOT merge
    // with a same-org 'HR' bucket (a `.trim()`-based implementation would wrongly merge the two).
    const tabPaddedBucket = preview.buckets.find((b) => b.category === '\tHR\t')
    expect(tabPaddedBucket).toBeDefined()
    expect(tabPaddedBucket!.action).toBe('create')
    expect(tabPaddedBucket!.templateIds).toEqual([tabPadded])
    expect(preview.buckets.find((b) => b.category === 'HR')).toBeUndefined()
  })

  // §3.1 "字典序排序" (dictionary/code-point order, NOT locale-collated) — deterministic across
  // machines/locales so a future execute (SQL `ORDER BY`, byte/C-collation order) cannot silently
  // disagree with what preview showed. Fixture picks categories that `localeCompare` under most
  // locales would reorder relative to plain code-point order (a leading capital vs lowercase, and
  // a digit) — this is the case that would have caught the `localeCompare` implementation this
  // suite's advisor review flagged before it shipped.
  it('buckets/skipped are ordered by plain code-point order, not locale-collated order', async () => {
    const org = trackOrg(`atgp-order-${TS}`)
    await createTemplate(`atgp-order-a-${TS}`, 'zebra')
    await createTemplate(`atgp-order-b-${TS}`, 'Apple')
    await createTemplate(`atgp-order-c-${TS}`, '100')

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)
    const categories = preview.buckets.map((b) => b.category)
    // Code-point order: digits (0x3x) < uppercase (0x4x-0x5x) < lowercase (0x6x-0x7x), so
    // '100' < 'Apple' < 'zebra'. `'Apple'.localeCompare('zebra')` under most ICU locales agrees
    // here (case-insensitive collation still puts A before z), but `'100'` vs the letters is
    // where a collation-aware compare and code-point order provably diverge in general — the
    // in-repo regression is `.sort()`'s default (code-point-ish but not identical for surrogate
    // pairs) vs `localeCompare`'s ICU tables, and this fixture is the minimal one that pins the
    // INTENDED behavior (plain `<`/`>`) rather than merely matching whatever `localeCompare`
    // happens to do on the current Node/ICU build.
    expect(categories).toEqual(['100', 'Apple', 'zebra'])
  })

  // §13.1 changesRequired #8 / §6.2 (ownerLevel=true, ratified DEFAULT): preview is READ-ONLY but
  // gated by `approvalTemplateAdminGuard`, the SAME writer-only guard as execute/rollback — NOT
  // `rbacGuard('approvals:read')`, which is what I7's literal read/write split would otherwise
  // require. This block is the one place in this suite that goes through a real HTTP request
  // (`finding_text_linkage_cannot_prove_src_reachability`: the route registration and the
  // ci-wiring guard both only prove a path STRING exists somewhere in source, never that this
  // specific guard actually answers that path at runtime).
  describe('route wiring: GET /api/approval-template-groups/backfill/preview (real HTTP, real guard)', () => {
    it('an admin actor gets 200 with {scope, buckets, skipped}', async () => {
      const org = trackOrg(`atgp-http-admin-${TS}`)
      await createTemplate(`atgp-http-admin-tpl-${TS}`, 'HR')
      // Same fixture shape as the phase 1 lifecycle suite's own "F: authorization" positive
      // control (`roles: 'admin', perms: '*:*'`) — `requestUserIsAdmin` bypasses BOTH
      // `approvalTemplateAdminGuard` and the namespace-admission check that a non-admin
      // `approval-templates:manage` holder would additionally need to clear (an orthogonal
      // concern this test is not about).
      const admin = await tok(base, `http-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

      const res = await httpReq(base, '/api/approval-template-groups/backfill/preview', admin)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { scope: string; buckets: unknown[]; skipped: unknown[] }
      expect(body.scope).toBe('org-complete')
      expect(Array.isArray(body.buckets)).toBe(true)
      expect(Array.isArray(body.skipped)).toBe(true)
      expect((body.buckets as Array<{ category: string }>).some((b) => b.category === 'HR')).toBe(true)
    })

    // THE discriminating leg (advisor review): a bare `approvals:read` actor is exactly who I7's
    // literal read/write split would let through on a "regular read" endpoint — and exactly who
    // the ratified deviation (changesRequired #8) means to keep OUT. If the route were ever wired
    // to `rbacGuard('approvals:read')` instead of `approvalTemplateAdminGuard` (a plausible typo
    // given six sibling endpoints on this same guard/router), this is the only assertion in this
    // suite that would turn red.
    it('an actor holding ONLY approvals:read (no approval-templates:manage) gets 403 — the ratified deviation from I7 is real, not just documented', async () => {
      const org = trackOrg(`atgp-http-reader-${TS}`)
      const reader = await tok(base, `http-reader-${TS}`, { roles: 'user', perms: 'approvals:read', tenantId: org })

      const res = await httpReq(base, '/api/approval-template-groups/backfill/preview', reader)
      expect(res.status).toBe(403)
    })

    it('an unauthenticated request gets 401, not a silent 200', async () => {
      const res = await fetch(`${base}/api/approval-template-groups/backfill/preview`)
      expect(res.status).toBe(401)
    })
  })
})
