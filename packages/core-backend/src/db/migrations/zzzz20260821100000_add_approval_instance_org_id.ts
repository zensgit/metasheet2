import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * Lock-10 (S1) instance-readability — org anchor, PHASE 1 ONLY.
 *
 * Ratified design: docs/development/approval-lock10-instance-readability-20260821.md
 * (Status: RATIFIED 2026-08-21; "Design authority ONLY — this ratification authorizes no runtime
 * code, no migration, no flag change, no UAT, no deployment and no completion label. Every OD
 * still needs its own PR...").
 *
 * OD-S1-9(a) [RATIFIED]: `approval_instances.org_id` — NO DB DEFAULT, EVER. A default silently
 * swallows a caller that forgot to pass an org and stamps the row into the wrong tenant, where it
 * then reads as legitimate membership. Precedent: `approval_attachments.org_id`
 * (zzzz20260715210000_create_approval_attachments.ts:23-24, NOT NULL + non-blank CHECK). Anti-
 * precedent: the attendance `org_id ... DEFAULT 'default'` family
 * (zzzz20260114100000_add_attendance_org_id.ts) — the shape this column must never take.
 *
 * OD-S1-9(b) [SESSION DESIGN AUTHORITY]: a three-phase migration (ADD nullable -> BACKFILL -> SET
 * NOT NULL) over SIX ORDERED row classes, cross-class conflict FAIL LOUD.
 * OD-S1-18(b) [SESSION DESIGN AUTHORITY, part of a RATIFIED OD]: phase 3 is NOT `SET NOT NULL` —
 * it is `CHECK (org_id IS NOT NULL OR id LIKE 'plm:%')`, because PLM mirror rows (class 5) never
 * get an org and must stay NULL permanently, not just during the migration window.
 *
 * THIS MIGRATION IS PHASE 1 (ADD nullable, no default, no constraint) PLUS THE ONE BACKFILL CLASS
 * THAT IS BOTH DERIVABLE AND SELF-CONTAINED AT THIS BASELINE — class 2, attachment-bearing
 * instances, source `approval_attachments.org_id` (already NOT NULL and non-blank there). It
 * deliberately stops there. Per the lock's own §5.1 owner-confirm table and its B-1/B-3/B-4/B-6
 * implementer findings, the following are NOT this migration and must not be inferred as landed:
 *
 *   - Phase 3, the CHECK / any NOT NULL enforcement (OD-S1-18(b)) — landing it before every writer
 *     of `approval_instances` passes `org_id` would 500 every create. At this baseline SIX writers
 *     (ApprovalProductService.ts:7508, ApprovalBridgeService.ts:1118, AfterSalesApprovalBridgeService
 *     .ts:515, plugin-attendance/index.cjs:24051, seed-approvals.ts, test-approvals-contract.mjs)
 *     supply none, and 27 test files `INSERT INTO approval_instances` directly without one. The
 *     house deploy rule (migration-before-image) additionally requires those writers to already be
 *     updated in the SAME deploy unit as the CHECK — they are not, in this slice.
 *   - Class 1 (template-originated) — the backfill source does not exist: `approval_templates`
 *     carries no org column in any migration at this baseline (only `category`, `visibility_scope`,
 *     `sla_hours` were ever added to it).
 *   - Class 3 (requester-resolvable) — blocked on OWNER-CONFIRM OD-S1-17(c) (multi-org viewers).
 *     `zzzz20260114110000_create_user_orgs_table.ts:34-40` backfills EVERY active user into
 *     `'default'`, so multi-org rows are the expected shape and "resolves to exactly one active org
 *     membership" is not a well-defined test today.
 *   - Class 4 (after-sales `afs:` mirrors) — "the deploy's org for the after-sales channel" has no
 *     plumbing anywhere in the repo (`AfterSalesApprovalBridgeService.ts` never reads
 *     org/tenant); an unset value must ABORT the migration when this class is later implemented,
 *     never default.
 *   - Class 6 (terminal, no source at all) — ABORT-and-report is the ruled posture for it, and it
 *     is not evaluated here: while classes 1/3/4 are unbackfilled, rows that actually belong to
 *     those classes would misclassify as class 6 first, which would abort this migration for a
 *     reason that is really "class 1/3/4 isn't wired yet", not a genuine structural hole.
 *
 * Class 5 (`plm:` mirrors) needs no statement: `org_id` stays NULL there permanently — permitted by
 * the (not-yet-added) CHECK's `id LIKE 'plm:%'` escape once OD-S1-18(b) lands as phase 3.
 *
 * Cross-class conflict is FAIL LOUD, not a silent pick (OD-S1-9(b)): before backfilling, this
 * migration aborts if any single instance's bound attachments carry `org_id` values from more than
 * one org — picking one would silently re-tenant the instance, and after OD-S1-10 (blocked on
 * `L9-AMEND`, not implemented in this slice) the instance-level org will govern attachment
 * downloads on a shipped route.
 *
 * No index added here: the predicate this slice introduces
 * (`services/approval-instance-readability.ts`) needs none — it is a primary-key lookup on
 * `approval_instances.id` with `org_id` read off the row already fetched. The backfill below is
 * set-based and does not require an index on `approval_attachments.instance_id` either (that table
 * has no such index at this baseline — its only index is
 * `idx_approval_att_unbound_sweep(status, created_at)`). Adding one is deliberately deferred to its
 * own FOLLOWING migration rather than folded back into this file, per the house rule recorded at
 * zzzz20260821090000_create_attendance_org_resolution_shadow.ts:15-23: once any environment has
 * this migration's name recorded as executed, kysely never re-runs it, so editing this file's
 * up() after the fact would leave that environment silently without the index.
 *
 * W4C-0 DML CENSUS: `approval_instances` is a `shared_hook`-bucket table
 * (`scripts/attendance/w4c0-dml-inventory/table-classification.cjs`), so this file's `UPDATE` is a
 * tracked site claimed by name in `GENERIC_SHARED_ALLOWLIST`
 * (`scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs`) — matched by `relPath` alone,
 * which claims every DML site in THIS file only. **A later migration implementing Phase 3 or the
 * class 1/3/4 backfills will have a different filename and needs its own allowlist row** — it does
 * not inherit this one. Skipping that will red `test (18.x)`'s census, not silently pass.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // PHASE 1 — additive, nullable, NO DEFAULT (OD-S1-9(a)). No constraint references this column
  // yet, so every existing writer of `approval_instances` (updated or not) is unaffected.
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS org_id text`.execute(db)

  // Defense in depth: some CI lanes run a NARROWER migration set than the full ledger (three
  // independent exclusion mechanisms exist — migration-provider.ts:21-59 — including two this
  // migration was never audited against: observability-strict.yml / observability-e2e.yml /
  // safety-guard-e2e.yml, and migration-replay.yml's OWN, independently-drifted MIGRATION_EXCLUDE
  // list). If `approval_attachments` isn't present in a given lane's migrated schema, the class-2
  // backfill has nothing to read and is correctly a no-op there — Phase 1 (the column add above)
  // still lands either way, which is the only thing this migration guarantees everywhere.
  if (!(await checkTableExists(db, 'approval_attachments'))) return

  // Pre-flight FAIL LOUD (OD-S1-9(b)): an instance whose bound attachments disagree on org_id
  // would silently re-tenant the instance if one value were picked arbitrarily.
  const conflicts = await sql<{ instance_id: string }>`
    SELECT instance_id
      FROM approval_attachments
     WHERE instance_id IS NOT NULL
     GROUP BY instance_id
    HAVING COUNT(DISTINCT org_id) > 1
     ORDER BY instance_id
  `.execute(db)
  if (conflicts.rows.length > 0) {
    const ids = conflicts.rows.map((row) => row.instance_id).join(', ')
    throw new Error(
      `approval_instance_org_id backfill aborted before UPDATE: instance(s) whose bound ` +
      `attachments carry org_id values from more than one org (class-2 cross-class FAIL LOUD, ` +
      `OD-S1-9(b)): ${ids}`,
    )
  }

  // CLASS 2 backfill — attachment-bearing instances. Set-based; only rows still NULL are touched,
  // so this migration is safe to replay against a database where a later migration has already
  // populated org_id by a different class.
  await sql`
    UPDATE approval_instances i
       SET org_id = a.org_id
      FROM (
        SELECT DISTINCT instance_id, org_id
          FROM approval_attachments
         WHERE instance_id IS NOT NULL
      ) a
     WHERE a.instance_id = i.id
       AND i.org_id IS NULL
  `.execute(db)

  // CLASS 5 (`plm:` mirrors): no statement — org_id stays NULL, which is the ruled posture
  // (OD-S1-18(b)). Classes 1, 3, 4 and 6: NOT run here — see docblock above.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_instances DROP COLUMN IF EXISTS org_id`.execute(db)
}
