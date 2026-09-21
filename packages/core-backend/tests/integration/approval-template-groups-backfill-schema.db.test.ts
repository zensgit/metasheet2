import { afterAll, describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pg'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3 ("backfill
 * by existing category") — real-DB acceptance for the batch-bookkeeping DDL alone
 * (`zzzz20260919090000_create_approval_template_group_backfill_batches.ts`). No route/service
 * code exists yet (W7 preview / W8 execute / W9 rollback are later units) — this file is schema
 * only, proving the design-gate's `changesRequired` DDL fixes are load-bearing at the catalog
 * level, not just prose in the design doc.
 *
 * Headline case is design-gate finding M6 / changesRequired #4
 * (`design-gate-A3-phase2-20260918.md`, a private review record not tracked in this repository,
 * §2 Q5): the design proposal's ORIGINAL
 * `atgbbl_link_fk … ON DELETE NO ACTION` blocked the already-ratified
 * `approval_templates -> approval_template_group_links ON DELETE CASCADE` chain (phase 1,
 * required because 10+ integration suites hard-delete their fixture templates in teardown). The
 * migration under test already carries the gate's fix (`ON DELETE CASCADE`); "positive control"
 * below proves the fixed shape does not deadlock that chain, and "negative control (mutation)"
 * proves the ORIGINAL shape really would have — by transactionally swapping the live constraint
 * back to `NO ACTION`, attempting the same delete, and rolling the whole transaction back (the
 * constraint is never left mutated; `cmp`-style restoration is unnecessary because Postgres DDL
 * is itself transactional here, unlike a source-file mutation probe).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
const TS = Date.now()

describeIfDatabase('approval template groups — phase 2 backfill batch DDL (design-gate A3, changesRequired #4/#5)', () => {
  const templateIds: string[] = []
  const orgTags: string[] = []
  const batchIds: string[] = []

  itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  afterAll(async () => {
    // Batch heads first: CASCADE removes their own batch_groups/batch_links rows for free, but a
    // negative-control test may have left a fixture whose batch head still needs an explicit
    // delete (its DELETE-under-mutation was rolled back on purpose).
    for (const id of batchIds.splice(0)) {
      await query(`DELETE FROM approval_template_group_backfill_batches WHERE id = $1`, [id])
    }
    for (const org of orgTags.splice(0)) {
      await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org])
    }
    for (const id of templateIds.splice(0)) {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [id])
    }
  })

  async function createTemplate(key: string): Promise<string> {
    const row = await query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, category) VALUES ($1, $1, 'HR') RETURNING id`,
      [key],
    )
    const id = row.rows[0].id
    templateIds.push(id)
    return id
  }

  async function createGroup(id: string, org: string): Promise<void> {
    orgTags.push(org)
    await query(
      `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by) VALUES ($1, $2, $2, 1, 'probe')`,
      [id, org],
    )
  }

  async function linkTemplate(org: string, templateId: string, groupId: string): Promise<Date> {
    const row = await query<{ linked_at: Date }>(
      `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
       VALUES ($1, $2, $3, 'probe', now()) RETURNING linked_at`,
      [org, templateId, groupId],
    )
    return row.rows[0].linked_at
  }

  async function createBatch(id: string, org: string): Promise<void> {
    batchIds.push(id)
    await query(
      `INSERT INTO approval_template_group_backfill_batches (id, org_id, created_by) VALUES ($1, $2, 'probe')`,
      [id, org],
    )
  }

  // ── index / catalog shape ─────────────────────────────────────────────────────────────────
  it('the org/created_at index required by changesRequired #5 exists on the batch head table', async () => {
    const res = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'approval_template_group_backfill_batches'`,
    )
    const names = res.rows.map((r) => r.indexname)
    expect(names).toContain('approval_template_group_backfill_batches_org_created_idx')
  })

  it('the three FK delete-actions match the design-gate Q5 ruling exactly (a=NO ACTION, c=CASCADE)', async () => {
    const res = await query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
        WHERE conname IN ('atgbbg_batch_fk', 'atgbbg_group_fk', 'atgbbl_batch_fk', 'atgbbl_link_fk')`,
    )
    const byName = Object.fromEntries(res.rows.map((r) => [r.conname, r.confdeltype]))
    expect(byName).toEqual({
      atgbbg_batch_fk: 'c', // batch_groups -> batch head: CASCADE (unchanged from proposal)
      atgbbg_group_fk: 'a', // batch_groups -> groups: NO ACTION (unchanged from proposal)
      atgbbl_batch_fk: 'c', // batch_links -> batch head: CASCADE (unchanged from proposal)
      atgbbl_link_fk: 'c', // batch_links -> links: CASCADE (design-gate changesRequired #4 — was
      // NO ACTION in the original proposal text; that direction is exactly what M6 disproved)
    })
  })

  // ── M6 / changesRequired #4 ──────────────────────────────────────────────────────────────
  it('M6 positive control: hard-deleting a linked template cascades through group_links into the batch_links row (no FK violation)', async () => {
    const org = `atgbb-m6-pos-${TS}`
    const tmplId = await createTemplate(`atgbb-m6-pos-t-${TS}`)
    await createGroup(`atgbb_m6_pos_g_${TS}`, org)
    const linkedAt = await linkTemplate(org, tmplId, `atgbb_m6_pos_g_${TS}`)
    await createBatch(`atgbb_m6_pos_b_${TS}`, org)
    await query(
      `INSERT INTO approval_template_group_backfill_batch_groups (batch_id, org_id, group_id, created_new) VALUES ($1, $2, $3, true)`,
      [`atgbb_m6_pos_b_${TS}`, org, `atgbb_m6_pos_g_${TS}`],
    )
    await query(
      `INSERT INTO approval_template_group_backfill_batch_links (batch_id, org_id, template_id, group_id, linked_at) VALUES ($1, $2, $3, $4, $5)`,
      [`atgbb_m6_pos_b_${TS}`, org, tmplId, `atgbb_m6_pos_g_${TS}`, linkedAt],
    )

    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_group_backfill_batch_links WHERE batch_id = $1`,
      [`atgbb_m6_pos_b_${TS}`],
    )
    expect(before.rows[0].n).toBe('1')

    // The delete this fix exists to un-block. Under the proposal's ORIGINAL NO ACTION shape this
    // threw `violates foreign key constraint "atgbbl_link_fk"` (design-gate M6 repro).
    await expect(query(`DELETE FROM approval_templates WHERE id = $1`, [tmplId])).resolves.toBeDefined()
    templateIds.splice(templateIds.indexOf(tmplId), 1) // already gone, afterAll must not re-delete it

    const linksAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_group_links WHERE org_id = $1`,
      [org],
    )
    expect(linksAfter.rows[0].n).toBe('0')
    const batchLinksAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_group_backfill_batch_links WHERE batch_id = $1`,
      [`atgbb_m6_pos_b_${TS}`],
    )
    expect(batchLinksAfter.rows[0].n).toBe('0')
  })

  it('M6 negative control (mutation): reverting atgbbl_link_fk to the proposal\'s original NO ACTION blocks the same delete', async () => {
    const org = `atgbb-m6-neg-${TS}`
    const tmplId = await createTemplate(`atgbb-m6-neg-t-${TS}`)
    await createGroup(`atgbb_m6_neg_g_${TS}`, org)
    const linkedAt = await linkTemplate(org, tmplId, `atgbb_m6_neg_g_${TS}`)
    await createBatch(`atgbb_m6_neg_b_${TS}`, org)
    await query(
      `INSERT INTO approval_template_group_backfill_batch_groups (batch_id, org_id, group_id, created_new) VALUES ($1, $2, $3, true)`,
      [`atgbb_m6_neg_b_${TS}`, org, `atgbb_m6_neg_g_${TS}`],
    )
    await query(
      `INSERT INTO approval_template_group_backfill_batch_links (batch_id, org_id, template_id, group_id, linked_at) VALUES ($1, $2, $3, $4, $5)`,
      [`atgbb_m6_neg_b_${TS}`, org, tmplId, `atgbb_m6_neg_g_${TS}`, linkedAt],
    )

    let caught: unknown = null
    await expect(
      transaction(async (client) => {
        // Reproduce the proposal's ORIGINAL (pre-gate) shape, live, inside a transaction that is
        // guaranteed to roll back — the committed schema is never mutated.
        await client.query(`ALTER TABLE approval_template_group_backfill_batch_links DROP CONSTRAINT atgbbl_link_fk`)
        await client.query(
          `ALTER TABLE approval_template_group_backfill_batch_links
             ADD CONSTRAINT atgbbl_link_fk FOREIGN KEY (org_id, template_id)
             REFERENCES approval_template_group_links (org_id, template_id)
             ON DELETE NO ACTION ON UPDATE NO ACTION`,
        )
        try {
          await client.query(`DELETE FROM approval_templates WHERE id = $1`, [tmplId])
        } catch (e) {
          caught = e
          throw e // force ROLLBACK of the ALTERs above along with the failed delete
        }
        throw new Error('expected the NO ACTION shape to reject this delete — it did not')
      }),
    ).rejects.toBeDefined()

    expect(caught).not.toBeNull()
    // NOTE on discriminating power: this /atgbbl_link_fk/ message match is NOT the assertion that
    // proves the mutation worked — it also passes under the fixed (CASCADE) migration, because
    // dropping+re-adding the constraint always names it in the DROP/ADD DDL and in the message on
    // ANY subsequent violation this session triggers, mutated or not (confirmed directly: this
    // file's mutation-probe run reddened the two assertions below, never this one). The signal
    // lives entirely in the confdeltype check that follows — do not delete this line as
    // "redundant" without checking that one first.
    expect(String((caught as { message?: string })?.message ?? caught)).toMatch(/atgbbl_link_fk/)

    // Schema-restoration proof, not an assumption: the constraint's delete-action in the catalog
    // is CASCADE again (the ALTERs were rolled back), and the SAME delete this test just watched
    // fail now succeeds for real — clean up via the real committed path. This IS the assertion
    // with discriminating power (see note above) — it is what actually reddened under the
    // migration-file mutation probe (atgbbl_link_fk reverted to NO ACTION in the .ts source).
    const restored = await query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'atgbbl_link_fk'`,
    )
    expect(restored.rows[0].confdeltype).toBe('c')
    await expect(query(`DELETE FROM approval_templates WHERE id = $1`, [tmplId])).resolves.toBeDefined()
    templateIds.splice(templateIds.indexOf(tmplId), 1)
  })

  // ── composite FK org-consistency ─────────────────────────────────────────────────────────
  it('atgbbg_group_fk rejects a batch_groups row whose group belongs to a DIFFERENT org than the batch', async () => {
    const orgBatch = `atgbb-xorg-bg-batch-${TS}`
    const orgGroup = `atgbb-xorg-bg-group-${TS}`
    await createGroup(`atgbb_xorg_bg_g_${TS}`, orgGroup)
    await createBatch(`atgbb_xorg_bg_b_${TS}`, orgBatch)
    await expect(
      query(
        `INSERT INTO approval_template_group_backfill_batch_groups (batch_id, org_id, group_id, created_new) VALUES ($1, $2, $3, true)`,
        [`atgbb_xorg_bg_b_${TS}`, orgBatch, `atgbb_xorg_bg_g_${TS}`],
      ),
    ).rejects.toThrow(/atgbbg_group_fk/)
  })

  it('atgbbl_link_fk rejects a batch_links row whose (org, template) link does not exist in that org', async () => {
    const orgLink = `atgbb-xorg-bl-link-${TS}`
    const orgBatch = `atgbb-xorg-bl-batch-${TS}`
    const tmplId = await createTemplate(`atgbb-xorg-bl-t-${TS}`)
    await createGroup(`atgbb_xorg_bl_g_${TS}`, orgLink)
    const linkedAt = await linkTemplate(orgLink, tmplId, `atgbb_xorg_bl_g_${TS}`)
    await createBatch(`atgbb_xorg_bl_b_${TS}`, orgBatch)
    await expect(
      query(
        `INSERT INTO approval_template_group_backfill_batch_links (batch_id, org_id, template_id, group_id, linked_at) VALUES ($1, $2, $3, $4, $5)`,
        [`atgbb_xorg_bl_b_${TS}`, orgBatch, tmplId, `atgbb_xorg_bl_g_${TS}`, linkedAt],
      ),
    ).rejects.toThrow(/atgbbl_link_fk/)
  })

  // ── batch-head cascade ───────────────────────────────────────────────────────────────────
  it('deleting a batch head cascades to its own batch_groups/batch_links rows without touching the groups/links they point at', async () => {
    const org = `atgbb-head-cascade-${TS}`
    const tmplId = await createTemplate(`atgbb-head-cascade-t-${TS}`)
    await createGroup(`atgbb_head_cascade_g_${TS}`, org)
    const linkedAt = await linkTemplate(org, tmplId, `atgbb_head_cascade_g_${TS}`)
    await createBatch(`atgbb_head_cascade_b_${TS}`, org)
    await query(
      `INSERT INTO approval_template_group_backfill_batch_groups (batch_id, org_id, group_id, created_new) VALUES ($1, $2, $3, true)`,
      [`atgbb_head_cascade_b_${TS}`, org, `atgbb_head_cascade_g_${TS}`],
    )
    await query(
      `INSERT INTO approval_template_group_backfill_batch_links (batch_id, org_id, template_id, group_id, linked_at) VALUES ($1, $2, $3, $4, $5)`,
      [`atgbb_head_cascade_b_${TS}`, org, tmplId, `atgbb_head_cascade_g_${TS}`, linkedAt],
    )

    await query(`DELETE FROM approval_template_group_backfill_batches WHERE id = $1`, [`atgbb_head_cascade_b_${TS}`])
    batchIds.splice(batchIds.indexOf(`atgbb_head_cascade_b_${TS}`), 1)

    const childGroups = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_group_backfill_batch_groups WHERE batch_id = $1`,
      [`atgbb_head_cascade_b_${TS}`],
    )
    expect(childGroups.rows[0].n).toBe('0')
    const childLinks = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_group_backfill_batch_links WHERE batch_id = $1`,
      [`atgbb_head_cascade_b_${TS}`],
    )
    expect(childLinks.rows[0].n).toBe('0')

    // The group and the (org,template) link the batch pointed at are untouched — the batch head
    // is bookkeeping about a write, not the write's target.
    const groupStillThere = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_groups WHERE id = $1`,
      [`atgbb_head_cascade_g_${TS}`],
    )
    expect(groupStillThere.rows[0].n).toBe('1')
    const linkStillThere = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, tmplId],
    )
    expect(linkStillThere.rows[0].n).toBe('1')
  })
})
