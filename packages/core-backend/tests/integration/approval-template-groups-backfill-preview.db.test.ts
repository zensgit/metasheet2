import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'
import { executeApprovalTemplateGroupBackfill, previewApprovalTemplateGroupBackfill } from '../../src/routes/approvals'
import type { ApprovalTemplateVisibilityActor } from '../../src/services/ApprovalProductService'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3 ("backfill
 * by existing category") — real-DB acceptance for **W7 preview only**
 * (`docs/development/approval-template-groups-phase2-backfill-design-20260918.md` §5,
 * `previewApprovalTemplateGroupBackfill` in `src/routes/approvals.ts`). W8 execute / W9 rollback
 * are separate units with their own dedicated `.db.test.ts` files and are not otherwise exercised
 * here — the one exception is the changesRequired #12 `candidateCount` coupling case below, which
 * calls the real `executeApprovalTemplateGroupBackfill` (not a copy of its query) specifically to
 * prove preview's count and execute's actual processed count cannot drift apart; every other case
 * in this file does not exercise any L0-taking transaction (preview itself takes no lock, §5.2).
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
      // The changesRequired #12 coupling case below is this file's only test that calls real
      // execute, so it is the only one that ever writes a batch header row — deleted first
      // (cascades to its own `..._batch_groups`/`..._batch_links` rows, §2's FK shape) so the
      // group/link deletes below never see a batch row still pointing at what they are about to
      // remove; a no-op for every other test's org.
      await query(`DELETE FROM approval_template_group_backfill_batches WHERE org_id = $1`, [org])
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
  // (not only in `afterAll`) is necessary but, corrected 2026-09-18 (§11 CI fix — see this file's
  // own `sinkForeignTemplates`), NOT sufficient on its own for "every `it` below gets its own clean
  // candidate population": it only reclaims templates THIS FILE created. The gated real-DB CI step
  // (`.github/workflows/plugin-tests.yml`, job id `approval-real-db-integration`) runs 84 files
  // (62 `.db.test.ts` + 14 `.api.test.ts` + 8 plain `.test.ts`, counted mechanically off that one
  // step's own file list) against one shared Postgres with `fileParallelism:false` (strictly
  // sequential, no cross-file race) — so a template some OTHER, earlier file in that run leaves
  // linked-nowhere (its own teardown never deletes `approval_templates` rows, because template
  // deletion was never part of that file's own contract) is *still sitting in the table* by the
  // time this file's `beforeAll` runs, and is an eligible candidate for every org this file uses,
  // independent of the org string. `sinkForeignTemplates` is what actually closes that gap.
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

  // §11 CI fix (shared-DB fixture collision, `feedback_shared_db_integration_fixture_collision`):
  // reproduced live (see the fix-round verification MD) that a bare, unlinked-anywhere
  // `approval_templates` row — regardless of which file or which org created it — is a candidate
  // for EVERY org's `previewApprovalTemplateGroupBackfill` call, because the candidate SELECT
  // carries no template-level org filter at all (only the link-exclusion is org-scoped). Renaming
  // this file's own org tags cannot fix that: a foreign row is a candidate for THIS org no matter
  // what string `org` is. This helper makes the environment match what a genuinely isolated org
  // would see by using the SAME production predicate against itself — link every template that is
  // currently a candidate for `org` (i.e. `NOT EXISTS` a link row for `org`) MINUS this test's own
  // `ownTemplateIds` into a throwaway "sink" group scoped to `org` alone. After this call, the
  // production NOT EXISTS check legitimately excludes every foreign row, so this file's exact-set
  // assertions (`toEqual`, not `toContain`) stay meaningful without being weakened.
  //
  // The sink group's name is deliberately outside every category any test in this file (or its
  // W8/W9 siblings) ever uses — `existingGroupIdByTrimmedName`'s lookup is `name = ANY(categories)`,
  // so a colliding name would silently flip a bucket's action from "create" to "attach". Its
  // `sort_order` is a large constant, clear of every `sort_order` value (1, 2) a fixture in this
  // suite ever hardcodes — `atg_sort_unique UNIQUE (org_id, sort_order)` would otherwise reject the
  // INSERT outright when a test also creates its own group at `sort_order = 1` in the same org.
  //
  // Disclosure: unlike production's candidate query, this sink query does NOT run
  // `applyTemplateVisibilityFilter` — it sweeps every org-unlinked row regardless of visibility
  // scope. That is sound ONLY because every exact-set assertion in this file that calls
  // `sinkForeignTemplates` runs under `managerActor` (`isTemplateManager: true`), where
  // `applyTemplateVisibilityFilter` is itself a no-op (§5.2's own scope rule). The one non-manager
  // case in this file (`§5.2 changesRequired #16` scope test, below) never calls this helper and
  // only asserts `.find(...).toBeDefined()`, not an exact set. A future non-manager test that
  // asserts an exact bucket/skipped array would need a visibility-aware sink, not this one.
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
    await sinkForeignTemplates(org, [hr1, hr2, finance])

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

    // changesRequired #12 (P2-2 cap branch): candidateCount = sum of every bucket's
    // templateCount (2 HR + 1 Finance).
    expect(preview.candidateCount).toBe(3)
  })

  it('buckets: action="attach" with the existing active group id when an active group already has this name (btrim-matched)', async () => {
    const org = trackOrg(`atgp-attach-${TS}`)
    await createGroup(`atg_preview_attach_${TS}`, org, 'HR')
    const tpl = await createTemplate(`atgp-attach-tpl-${TS}`, '  HR  ') // btrim(' HR ') = 'HR' — same active group
    await sinkForeignTemplates(org, [tpl])

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
    const archivedTpl = await createTemplate(`atgp-archived-tpl-${TS}`, 'Legal')
    await sinkForeignTemplates(org, [archivedTpl])

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
    // §11 CI fix: this is the exact case reproduced live against the shared real-DB step — a
    // foreign, unrelated file's own leftover `category IS NULL` template (never linked anywhere,
    // by a different file entirely) lands in THIS org's `''`-keyed CATEGORY_BLANK_AFTER_TRIM
    // bucket unless it is sunk first (see `sinkForeignTemplates`'s own comment for the mechanism).
    await sinkForeignTemplates(org, [nullCat, blankCat, chineseCat])

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
    // changesRequired #12: skipped rows are never candidates — all three templates here are
    // skip-only, so candidateCount is 0, not 3.
    expect(preview.candidateCount).toBe(0)
  })

  it('changesRequired #12: candidateCount is the SAME population execute actually processes, computed from the SAME predicate (not a second, independently-drifting query) — asserted by running both against one org with a skip-eligible mix', async () => {
    const org = trackOrg(`atgp-candidatecount-${TS}`)
    const cc1 = await createTemplate(`atgp-cc-hr1-${TS}`, 'HR')
    const cc2 = await createTemplate(`atgp-cc-hr2-${TS}`, 'HR')
    const cc3 = await createTemplate(`atgp-cc-fin-${TS}`, 'Finance')
    const cc4 = await createTemplate(`atgp-cc-cjk-${TS}`, '人事') // skip-eligible: CATEGORY_NOT_STORABLE_AS_GROUP_NAME
    const cc5 = await createTemplate(`atgp-cc-blank-${TS}`, '   ') // skip-eligible: CATEGORY_BLANK_AFTER_TRIM
    // §11 CI fix: sunk BEFORE both calls below — the SAME org is reused for the coupled `execute`
    // call further down, so one sink covers both (a foreign row, once sunk, stays linked in this
    // org for the rest of the `it`).
    await sinkForeignTemplates(org, [cc1, cc2, cc3, cc4, cc5])

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)
    expect(preview.candidateCount).toBe(3) // 2 HR + 1 Finance — the two skip rows excluded
    // Defense-in-depth, not a substitute for the cross-call assertion below: candidateCount must
    // equal what a reader summing `buckets[].templateCount` themselves would get.
    expect(preview.candidateCount).toBe(preview.buckets.reduce((sum, b) => sum + b.templateCount, 0))

    // The actual cross-check: execute (§13.2's `eligible` query, changesRequired #3's IDENTICAL
    // `btrim(category) ~ '[!-~]'` predicate) must process EXACTLY `candidateCount` templates — the
    // number preview told the caller to expect BEFORE any write happened. Calling execute after
    // reading `preview.candidateCount` (not before) is what proves this is a same-predicate
    // coupling and not two independently-typed counts that merely happen to agree today.
    const executed = await executeApprovalTemplateGroupBackfill(org, managerActor, `probe-${TS}`)
    const executedCount = executed.groups.reduce((sum, g) => sum + g.templateIds.length, 0)
    expect(executedCount).toBe(preview.candidateCount)
  })

  it('I2′ population (§5.1): a template already linked to ANY group (even after being unlinked and never relinked would still be excluded — this asserts the still-linked leg) never appears in buckets or skipped', async () => {
    const org = trackOrg(`atgp-linked-${TS}`)
    await createGroup(`atg_preview_linked_g_${TS}`, org, 'AlreadyLinked')
    const linkedTpl = await createTemplate(`atgp-linked-tpl-${TS}`, 'AlreadyLinked')
    await linkTemplate(org, linkedTpl, `atg_preview_linked_g_${TS}`)
    const unlinkedTpl = await createTemplate(`atgp-unlinked-tpl-${TS}`, 'AlreadyLinked')
    await sinkForeignTemplates(org, [linkedTpl, unlinkedTpl])

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
    const hrTpl = await createTemplate(`atgp-nowrite-hr-${TS}`, 'HR')
    const blankTpl = await createTemplate(`atgp-nowrite-blank-${TS}`, '')
    await sinkForeignTemplates(org, [hrTpl, blankTpl])

    // §11 CI fix: the baseline is captured AFTER `sinkForeignTemplates`, not before. The sink's own
    // group/link rows are real writes this fixture itself just made to `org` — asserting a literal
    // `{ groups: 0, links: 0 }` precondition would now be false regardless of `preview`'s own
    // behaviour. The invariant under test ("preview writes zero rows") is still fully enforced —
    // just as a DELTA across the `preview` call rather than against a hardcoded absolute zero.
    // `before.groups` staying pinned at exactly 1 (only the sink group this fixture created) is the
    // one absolute check that still makes sense to keep.
    const before = await tableCounts(org)
    expect(before.groups).toBe(1)

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
    await sinkForeignTemplates(org, [tabOnly, tabPadded])

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
    const orderA = await createTemplate(`atgp-order-a-${TS}`, 'Zebra')
    const orderB = await createTemplate(`atgp-order-b-${TS}`, 'apple')
    const orderC = await createTemplate(`atgp-order-c-${TS}`, '100')
    // §11 CI fix: this test asserts the FULL `categories` array by exact equality — a single
    // foreign category anywhere in the shared DB (sorting between these three) would break it.
    await sinkForeignTemplates(org, [orderA, orderB, orderC])

    const preview = await previewApprovalTemplateGroupBackfill(org, managerActor)
    const categories = preview.buckets.map((b) => b.category)
    // This EXACT pair is the one that discriminates (verified live on this Node/ICU build,
    // `node -e "console.log(['Zebra','apple'].sort((a,b)=>a.localeCompare(b)), ['Zebra','apple']
    // .sort((a,b)=>a<b?-1:a>b?1:0))"` → localeCompare gives `['apple','Zebra']` (case-insensitive
    // primary-level collation puts lowercase 'a' before uppercase 'Z'), plain `<`/`>` gives
    // `['Zebra','apple']` (all uppercase code points precede all lowercase). An EARLIER version of
    // this fixture used 'zebra'/'Apple' (lowercase z, uppercase A) — that pair happens to agree
    // under BOTH orderings on this build (case-insensitive collation still puts 'A' before 'z',
    // same as code-point order), so it had zero power to catch a regression back to
    // `localeCompare` (`feedback_ineffective_mutation_looks_like_a_useless_test`). '100' stays in
    // the fixture too: it sorts first under both orderings here, so it does not by itself
    // discriminate, but keeps the "digits are storable and eligible" leg covered.
    expect(categories).toEqual(['100', 'Zebra', 'apple'])
  })

  // §13.1 changesRequired #8 / §6.2 (ownerLevel=true, ratified DEFAULT): preview is READ-ONLY but
  // gated by `approvalTemplateAdminGuard`, the SAME writer-only guard as execute/rollback — NOT
  // `rbacGuard('approvals:read')`, which is what I7's literal read/write split would otherwise
  // require. This block is the one place in this suite that goes through a real HTTP request
  // (`finding_text_linkage_cannot_prove_src_reachability`: the route registration and the
  // ci-wiring guard both only prove a path STRING exists somewhere in source, never that this
  // specific guard actually answers that path at runtime).
  describe('route wiring: GET /api/approval-template-groups/backfill/preview (real HTTP, real guard)', () => {
    it('an admin actor gets 200 with {scope, candidateCount, buckets, skipped}', async () => {
      const org = trackOrg(`atgp-http-admin-${TS}`)
      const httpAdminTpl = await createTemplate(`atgp-http-admin-tpl-${TS}`, 'HR')
      await sinkForeignTemplates(org, [httpAdminTpl])
      // Same fixture shape as the phase 1 lifecycle suite's own "F: authorization" positive
      // control (`roles: 'admin', perms: '*:*'`) — `requestUserIsAdmin` bypasses BOTH
      // `approvalTemplateAdminGuard` and the namespace-admission check that a non-admin
      // `approval-templates:manage` holder would additionally need to clear (an orthogonal
      // concern this test is not about).
      const admin = await tok(base, `http-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

      const res = await httpReq(base, '/api/approval-template-groups/backfill/preview', admin)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { scope: string; candidateCount: number; buckets: unknown[]; skipped: unknown[] }
      expect(body.scope).toBe('org-complete')
      // changesRequired #12: this is the field's ONLY over-the-HTTP-wire assertion in this file —
      // every other case calls the exported function directly, which would not catch a JSON
      // serialization regression (e.g. Express's default JSON replacer dropping an `undefined`).
      expect(body.candidateCount).toBe(1)
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
