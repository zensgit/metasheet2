import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3
 * ("backfill by existing category") batch bookkeeping.
 *
 * Provenance: design proposal `docs/development/approval-template-groups-phase2-backfill-design-20260918.md`
 * §2, AS AMENDED by the independent design-gate verdict
 * `reviews/design-gate-A3-phase2-20260918.md` (folded into the proposal's §13.1). The gate found
 * one real defect in the proposal's original DDL text (changesRequired #4, real-DB M6): the
 * proposal had `atgbbl_link_fk … ON DELETE NO ACTION`; the CREATE TABLE below already carries the
 * gate's fix (`ON DELETE CASCADE`) — see that constraint's own comment for the deadlock this
 * closes. changesRequired #5 (the `(org_id, created_at DESC)` index) is likewise already applied.
 *
 * Header + two detail tables record ONE `execute` call so a later `rollback` can undo EXACTLY
 * that batch — archive only the groups it created (and only if now empty) and unlink only the
 * template↔group pairs it wrote — without touching anything outside the batch (§4). A single
 * JSONB "before/after" ledger was considered and rejected (see the design doc's "批次机制选择"
 * section): rollback needs a service-side SET-based join against these rows, a same-org
 * composite-FK guarantee, and per-(batch,template) uniqueness — none of which a JSONB blob gives
 * for free.
 *
 * Additive only, Draft-only migration. The W7 (preview) / W8 (execute) / W9 (rollback) route
 * layer that reads and writes these tables has since landed (`src/routes/approvals.ts`,
 * `src/services/ApprovalTemplateGroupService.ts`) — see each function's own doc comment and the
 * `approval-template-groups-backfill-{preview,execute,rollback}-ci-wiring.test.mjs` guards; this
 * migration remains Draft-only (unapplied to any shared/staging/prod database) regardless. Phase
 * 1's `approval_template_groups` / `approval_template_group_links`
 * (`zzzz20260918090000_create_approval_template_groups.ts`) are untouched by this file.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_template_group_backfill_batches (
      id             text PRIMARY KEY,                 -- 'atgbb_' + randomUUID(), same generator
                                                         -- convention as phase 1's 'atg_' ids
      org_id         text NOT NULL
                       CONSTRAINT atgbb_org_nonblank CHECK (org_id ~ '[!-~]'),
      created_by     text NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      rolled_back_at timestamptz,                       -- NULL = not yet rolled back
      -- Referenced side of the two detail tables' composite FK below — a plain UNIQUE existing
      -- purely to be an FK target, the same role phase 1's atg_org_id_uni plays for
      -- approval_template_groups.
      CONSTRAINT atgbb_org_id_uni UNIQUE (id, org_id)
    )
  `.execute(db)

  // design-gate changesRequired #5: supports "list this org's batches, most recent first"
  // (GET /api/approval-template-groups/backfill/batches, W9-adjacent) — the batch head table has
  // no other index an org-scoped, recency-ordered list query could use. `rolled_back_at` is not
  // part of this index: the list endpoint returns every batch and lets the client render
  // `rolledBackAt`, it is not a filter predicate.
  await sql`
    CREATE INDEX IF NOT EXISTS approval_template_group_backfill_batches_org_created_idx
    ON approval_template_group_backfill_batches (org_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS approval_template_group_backfill_batch_groups (
      batch_id     text NOT NULL,
      org_id       text NOT NULL,
      group_id     text NOT NULL,
      -- true = this batch CREATED the group; false = this batch attached to an already-existing
      -- active group of the same (btrim'd) name. rollback's "archive only what this batch
      -- created, and only if now empty" rule (§4) reads this column directly as data — it cannot
      -- be re-derived later, because a group touched by more than one batch would otherwise lose
      -- its true provenance to whichever batch is inspected last.
      created_new  boolean NOT NULL,
      PRIMARY KEY (batch_id, group_id),
      CONSTRAINT atgbbg_batch_fk FOREIGN KEY (batch_id, org_id)
        REFERENCES approval_template_group_backfill_batches (id, org_id)
        ON DELETE CASCADE ON UPDATE NO ACTION,
      -- NO ACTION, same as phase 1's atgl_group_fk: archiving a group is an UPDATE (sets
      -- archived_at, clears sort_order) — never a DELETE — so this FK is not expected to fire on
      -- any live path. Design-gate Q5: kept as originally proposed, unlike atgbbl_link_fk below.
      CONSTRAINT atgbbg_group_fk FOREIGN KEY (org_id, group_id)
        REFERENCES approval_template_groups (org_id, id)
        ON DELETE NO ACTION ON UPDATE NO ACTION
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS approval_template_group_backfill_batch_links (
      batch_id    text NOT NULL,
      org_id      text NOT NULL,
      template_id uuid NOT NULL,
      group_id    text NOT NULL,        -- the group this batch linked template_id into
      linked_at   timestamptz NOT NULL, -- the upsert's RETURNING linked_at — rollback's
                                         -- optimistic-concurrency token (§4.2). Written via a
                                         -- data-modifying CTE and compared via a server-side SET
                                         -- update, never round-tripped through a JS Date — a
                                         -- microsecond-vs-millisecond mismatch there made the
                                         -- token compare unequal 100% of the time (design-gate
                                         -- M4, changesRequired #2).
      PRIMARY KEY (batch_id, template_id),
      CONSTRAINT atgbbl_batch_fk FOREIGN KEY (batch_id, org_id)
        REFERENCES approval_template_group_backfill_batches (id, org_id)
        ON DELETE CASCADE ON UPDATE NO ACTION,
      -- CASCADE — NOT the design proposal's original NO ACTION (design-gate changesRequired #4,
      -- real-DB M6). approval_templates -> approval_template_group_links is itself
      -- ON DELETE CASCADE (phase 1 migration, required by the ratified lock text because 10+
      -- integration test suites hard-delete their fixture templates in teardown). A NO ACTION
      -- referencer sitting one more hop down that same cascade chain blocks the whole chain
      -- outright: reproduced against this exact DDL shape, hard-deleting a linked template threw
      -- "ERROR: … violates foreign key constraint atgbbl_link_fk" before this fix (see the
      -- design-gate report's M6 repro SQL). CASCADE here is correct, not just permissive: once
      -- the template itself is hard-deleted there is nothing left for a rollback to restore, so
      -- its rollback-batch-link row should disappear with it.
      CONSTRAINT atgbbl_link_fk FOREIGN KEY (org_id, template_id)
        REFERENCES approval_template_group_links (org_id, template_id)
        ON DELETE CASCADE ON UPDATE NO ACTION
    )
  `.execute(db)
}

// CANDIDATE, review-requested — see the private review record
// "approval-template-groups-phase2-backfill-ddl-declaration-20260920.md" (not in this repo; it
// lives in the reviewer's private review-notes tree, not under a repo `reviews/` directory)
// §1.6(b) / R2 / Q4b (not yet ratified; this guard is itself an unratified candidate, not a
// closed decision). §1.6(b) established that this migration's down() does not undo any business
// effect: `approval_template_groups` rows created and `approval_template_group_links` rows
// written by a completed `execute` call survive untouched. The three tables dropped below are the
// SOLE record of which rows a given batch touched — dropping them after even one successful
// `execute` destroys the evidence a later manual, per-row compensation would need, while leaving
// the compensated-for state in place (R2: "「应用过、execute 过、再 down()」是一条不可逆路径").
//
// Fail closed while any of the three tables holds a row: refuse the plain rollback, leave all
// three tables in place (dormant, not dropped), and point at the retention/cleanup decision this
// is instead of doing it implicitly. Same shape as the existing precedent in this migrations
// directory (`zzzz20260731120000_w4c3a_import_rollback_foundation.ts`'s `emptySurfaceGuard`), plus
// an explicit opt-out: set ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP=true (mirrors migrate.ts's
// ALLOW_DB_RESET gate for --reset) to force the drop anyway. Forcing is a decision to discard the
// ledger's retention value, not a mechanical unblock — it still does not undo the business effect
// it can no longer track afterward (§1.6(b) applies exactly the same post-force). Scope note: unlike
// ALLOW_DB_RESET (read at the migrate.ts CLI boundary and documented in its own --help text), this
// variable is read inside the migration file itself — a wider surface (any caller of this
// migration's down(), not just the --reset CLI path) with no CLI-level `--help` mention of its own;
// registered instead in `migrate.ts --help`'s Notes section so `--rollback`/`--reset` operators can
// still discover it, and down() logs a console.warn when it takes effect (see below).
//
// `to_regclass` guards each count with TWO separate statements — first check existence, and only
// query `count(*)` when the table exists — the same two-statement shape as the precedent this was
// modeled on (`...w4c3a_import_rollback_foundation.ts:740-767`: a `SELECT to_regclass(...) IS NOT
// NULL AS exists` statement, then a conditional `SELECT count(*)` in TS only when that came back
// true). A single `CASE WHEN to_regclass(...) IS NULL THEN 0 ELSE (SELECT count(*) FROM t) END`
// statement does NOT have this property: Postgres resolves every relation name referenced anywhere
// in a statement at parse/analyze time, before the CASE branches are ever evaluated, so the `ELSE`
// branch's table name is looked up even when the `WHEN` guard would make it unreachable — a
// half-applied `up()` (one or more of the three tables missing) crashes with 42P01 instead of
// reading as zero rows. This file originally used that single-statement CASE form and did hit the
// 42P01 it was meant to avoid; the two-statement form below does not, because the second statement
// is a separate `sql.raw` call issued only when the first one already proved the table exists.
const ATG_BACKFILL_DOWN_FORCE_ENV = 'ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP'

async function atgBackfillTableRowCount(db: Kysely<unknown>, table: string): Promise<number> {
  const reg = await sql.raw(`SELECT to_regclass('public.${table}') IS NOT NULL AS e`).execute(db)
  if (!Boolean((reg.rows[0] as { e?: boolean } | undefined)?.e)) return 0
  const result = await sql.raw(`SELECT count(*)::int AS n FROM ${table}`).execute(db)
  const row = (result.rows[0] ?? {}) as { n?: number | string }
  return Number(row.n ?? 0)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const batches = await atgBackfillTableRowCount(db, 'approval_template_group_backfill_batches')
  const groups = await atgBackfillTableRowCount(db, 'approval_template_group_backfill_batch_groups')
  const links = await atgBackfillTableRowCount(db, 'approval_template_group_backfill_batch_links')
  const total = batches + groups + links

  if (total > 0) {
    if (process.env[ATG_BACKFILL_DOWN_FORCE_ENV] !== 'true') {
      throw new Error(
        'ATG_BACKFILL_DOWN_BLOCKED: refusing to drop ' +
          'approval_template_group_backfill_{batches,batch_groups,batch_links} while data is present ' +
          `(batches=${batches}, batch_groups=${groups}, batch_links=${links}). Dropping these tables ` +
          'does NOT undo the groups/links they recorded — it only destroys the ledger a later per-row ' +
          'compensation would need. This is a data-retention/cleanup decision, not a mechanical ' +
          `rollback step: set ${ATG_BACKFILL_DOWN_FORCE_ENV}=true to force it, or leave the tables in ` +
          'place (dormant) and revert application code instead.',
      )
    }
    // Force path taken: log what is about to be discarded before doing it, so the operator's own
    // terminal/CI log carries this fact even though the CLI itself (migrate.ts) never reads this
    // variable and cannot print it for them.
    console.warn(
      `${ATG_BACKFILL_DOWN_FORCE_ENV}=true — forcing the drop of ` +
        'approval_template_group_backfill_{batches,batch_groups,batch_links} while data is present ' +
        `(batches=${batches}, batch_groups=${groups}, batch_links=${links}). This ledger cannot be ` +
        'recovered after this call returns.',
    )
  }

  // Child tables first — both hold FKs onto the batch head table.
  await sql`DROP TABLE IF EXISTS approval_template_group_backfill_batch_links`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_template_group_backfill_batch_groups`.execute(db)
  await sql`DROP INDEX IF EXISTS approval_template_group_backfill_batches_org_created_idx`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_template_group_backfill_batches`.execute(db)
}
