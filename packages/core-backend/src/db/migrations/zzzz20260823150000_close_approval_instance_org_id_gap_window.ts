import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

/**
 * Lock-11 §10.3 (seventh by-reference ruling, item 1 — "gap-closer 迁移", AUTHORIZED 2026-08-22 by
 * the owner's SEVENTH by-reference reply, 「按建议执行」) — GAP-CLOSER migration for the
 * Migration-B -> W1W2 NULL-row CREATION WINDOW.
 *
 * Ratified provenance: docs/development/approval-lock11-writer-org-derivation-20260822.md §10.3
 * (this same PR), quoting the closeout-plan review item 1 verbatim: "gap-closer 迁移(P1-2):同
 * (i)-guarded 模式的第二个收口迁移,折进 W1W2 切片、随其部署执行——把「Migration B 一次性执行→W1W2
 * 上线」之间产生的 NULL 行窗口结构性归零". Ruling: **AUTHORIZED** — "a second (i)-guarded backfill
 * migration (same single-org self-assertion, FAIL-LOUD, same class semantics over `org_id IS NULL`
 * platform rows) rides the W-1/W-2 slice and executes at ITS deploy — the Migration-B->W1W2
 * creation window becomes structurally nil".
 *
 * THE WINDOW, PRECISELY. `zzzz20260823100000_backfill_approval_instance_org_id.ts` ("Migration B")
 * is a ONE-SHOT backfill: it resolves (stamps, or permanently classifies as NULL) every
 * `org_id IS NULL` row that existed AT ITS OWN DEPLOY. From that deploy until THIS migration's own
 * deploy (the W-1/W-2 slice, which is the first to make either writer DERIVE `org_id` at CREATE
 * time), any `approval_instances` row created via the OLD (pre-derivation) code path got NO org
 * stamp at all — not because it is unresolvable, but because nothing tried. That is "the window".
 * This migration closes it, once, by re-running the SAME (i)-guarded pattern Migration B's class-6
 * revision uses (single-active-org premise self-asserted INSIDE the migration, FAIL-LOUD retained,
 * idempotent, prefix-guarded), scoped by TIME rather than by row-shape: every row `created_at` AFTER
 * Migration B's OWN recorded execution timestamp (read from kysely's own migration ledger —
 * `kysely_migration.timestamp`, the only authoritative record in this database of when Migration B
 * actually ran, since the two migrations execute in DIFFERENT deploys and no other artefact
 * carries that fact).
 *
 * SCOPE DECISION, DISCLOSED (not silently narrower, not silently broader than the ruling text):
 * this migration does NOT reproduce Migration B's six-class taxonomy (template-originated /
 * attachment-bearing / requester-resolvable / afs / plm / terminal) for the window population.
 * It stamps EVERY `org_id IS NULL` platform-id row created after the boundary, regardless of
 * `template_id` or bound attachments, with the ONE self-asserted active org. This is deliberate,
 * not an oversight: Migration B's six classes exist to pick the CORRECT source when more than one
 * DISTINCT org could be in play. Under the single-active-org premise this migration self-asserts
 * (the same premise Migration B's class-6 revision and the companion provisioning migration both
 * require), there is only ONE possible correct org value in the ENTIRE system — so every window
 * row, whatever its shape, resolves to the same answer a class-2/class-3/class-6 walk would have
 * produced anyway, and replicating the taxonomy would add code with no discriminating power. The
 * temporal (`created_at`) boundary is what keeps this migration's population DISJOINT from
 * Migration B's own: every row Migration B already resolved or permanently classified (including
 * class-1 residue, which stays NULL by design, forever, regardless of the single-org premise) was
 * created AT OR BEFORE Migration B's timestamp, so this migration's `created_at >` guard can never
 * re-touch it. Ordering (this migration's timestamp `zzzz20260823150000` sorts strictly after
 * Migration B's `zzzz20260823100000`) only fixes RUN order within one `db:migrate` invocation; the
 * `created_at` boundary is what fixes the ROW population, and is the one this migration actually
 * depends on, because on a fresh/CI database both migrations run back-to-back in the SAME
 * invocation with (at most) a fresh empty `approval_instances` table, so the window is empty there
 * by construction and this migration is a harmless no-op — see CI POSTURE below.
 *
 * IDEMPOTENCY / REPLAY: the census and the STAMP UPDATE share ONE predicate, reproduced VERBATIM in
 * both places (WINDOW_PREDICATE, below) — the same discipline `zzzz20260823100000`'s CLASS_6_PREDICATE
 * uses, for the same reason (a census/UPDATE divergence would silently under- or over-report). Both
 * are scoped `org_id IS NULL`, so a re-run of this migration's own output is a no-op: a row this
 * migration (or an earlier one) already stamped is never touched again, even if the set of active
 * orgs has since changed (the single-org premise is re-measured on every run, but the `org_id IS
 * NULL` scope means only genuinely-still-NULL rows are ever candidates).
 *
 * FAIL-LOUD, VALUES-FREE: if the window is non-empty (`n > 0`) and the single-active-org premise
 * does NOT hold (zero or more than one distinct active org), this migration ABORTS before any
 * UPDATE and reports CARDINALITY ONLY — no instance id, no org id, no user id — matching the
 * values-free discipline `zzzz20260823100000`'s class-6 abort and `approval-s1-org-backfill-
 * evidence.yml` both already apply. If the window is empty, the single-org premise is never even
 * measured (nothing to abort over) — same short-circuit Migration B's own class-6 census uses.
 *
 * TRANSACTIONAL POSTURE: kysely wraps migration execution in a transaction on the Postgres dialect;
 * the ABORT throw happens strictly before the STAMP UPDATE statement is issued, so an abort here
 * leaves zero partial writes.
 *
 * GUARDS (all REQUIRED):
 *   - `checkColumnExists(db, 'approval_instances', 'org_id')`: same rationale as every prior
 *     migration in this family — `allowUnorderedMigrations: true`
 *     (`packages/core-backend/src/db/migrate.ts:32`) means this migration's name can be recorded
 *     before Phase 1 has added the column; an early return keeps that a safe no-op.
 *   - `checkTableExists(db, 'user_orgs')`: needed for the single-org premise query; excluded in
 *     several non-plugin-tests CI lanes (`observability-strict.yml`, `observability-e2e.yml`,
 *     `safety-guard-e2e.yml`, `migration-replay.yml`) — same rationale as Migration B's identical
 *     guard.
 *   - `checkTableExists(db, 'kysely_migration')`: defensive — this table is created by kysely's own
 *     `Migrator` before any migration's `up()` runs, so it is expected to always exist; guarded
 *     anyway for symmetry with the other two REQUIRED guards and because this migration's only
 *     purpose is reading it.
 *   - Missing kysely_migration ROW for Migration B's name (as opposed to the table itself): NOT a
 *     hard guard failure. If Migration B's own execution was never recorded on this database
 *     (unordered migrations, or a lane whose MIGRATION_EXCLUDE list drops it), there is no boundary
 *     to measure the window from, so this migration logs and returns — a safe no-op, not an abort,
 *     matching the "acceptable only because it is safe on a fresh/never-run-Migration-B DB" honesty
 *     the earlier guards already accept.
 *
 * CI POSTURE: not added to any `MIGRATION_EXCLUDE` list; runs in every CI lane's `db:migrate` step.
 * On an empty database every relevant table has zero rows, so the census is 0 and this migration is
 * a harmless no-op there — the only way it can hard-error on an empty DB is a missing relation,
 * which the three guards above exist to prevent.
 *
 * W4C-0 DML CENSUS: `approval_instances` is a `shared_hook`-bucket table
 * (`scripts/attendance/w4c0-dml-inventory/table-classification.cjs`); this file's UPDATE is claimed
 * by the SAME `GENERIC_SHARED_ALLOWLIST` row `zzzz20260823100000` uses (matched by relPath — this
 * file needs its OWN row, added in this same PR to `curated-debt-entries.cjs`).
 *
 * No index added here (same "no index" reasoning as every prior migration in this family — a
 * one-shot corrective write, not a hot path). No down()-side data reversal — see down() below.
 */

const BACKFILL_MIGRATION_NAME = 'zzzz20260823100000_backfill_approval_instance_org_id'

export async function up(db: Kysely<unknown>): Promise<void> {
  // See GUARDS above.
  if (!(await checkColumnExists(db, 'approval_instances', 'org_id'))) return
  if (!(await checkTableExists(db, 'user_orgs'))) return
  if (!(await checkTableExists(db, 'kysely_migration'))) return

  const log = (line: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[approval-org-gap-closer] ${line}`)
  }

  // The boundary: Migration B's OWN recorded execution timestamp on THIS database. Not this
  // migration's own filename timestamp (that only fixes run ORDER, not real deploy time — Migration
  // B's file is named `...100000` but its actual prod execution was 2026-08-22T17:16Z, a full day
  // before its own filename date; using the filename here would be silently wrong).
  const backfillRecord = await sql<{ ts: string }>`
    SELECT timestamp AS ts FROM kysely_migration WHERE name = ${BACKFILL_MIGRATION_NAME}
  `.execute(db)
  const backfillTimestamp = backfillRecord.rows[0]?.ts
  if (!backfillTimestamp) {
    log(
      `skip: ${BACKFILL_MIGRATION_NAME} is not recorded in kysely_migration on this database ` +
      `(unordered history or an excluded lane) — no window boundary to measure from`,
    )
    return
  }

  // WINDOW_PREDICATE reproduced VERBATIM in TWO places (this census, and the STAMP UPDATE below) —
  // see the docblock's IDEMPOTENCY section for why a divergence between the two would be dangerous.
  const windowCensus = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM approval_instances i
     WHERE i.org_id IS NULL
       AND i.id NOT LIKE 'plm:%'
       AND i.id NOT LIKE 'afs:%'
       AND COALESCE(i.source_system, 'platform') = 'platform'
       AND i.created_at > ${backfillTimestamp}::timestamptz
  `.execute(db)
  const n = Number(windowCensus.rows[0]?.n ?? '0')
  if (n === 0) {
    log('window_rows=0')
    return
  }

  const activeOrgs = await sql<{ org_id: string }>`
    SELECT DISTINCT org_id FROM user_orgs WHERE is_active = TRUE
  `.execute(db)
  if (activeOrgs.rows.length !== 1) {
    throw new Error(
      `approval_instance_org_id gap-closer aborted before any UPDATE: ${n} instance(s) created ` +
      `after the Migration B backfill (${BACKFILL_MIGRATION_NAME}) still carry a NULL org_id, and ` +
      `the single-active-org premise does not hold (${activeOrgs.rows.length} distinct active ` +
      `orgs). Instance ids are NOT interpolated (values-free discipline).`,
    )
  }

  const theOrgId = activeOrgs.rows[0]!.org_id
  const stamp = await sql`
    UPDATE approval_instances i
       SET org_id = ${theOrgId}
     WHERE i.org_id IS NULL
       AND i.id NOT LIKE 'plm:%'
       AND i.id NOT LIKE 'afs:%'
       AND COALESCE(i.source_system, 'platform') = 'platform'
       AND i.created_at > ${backfillTimestamp}::timestamptz
  `.execute(db)
  log(`window_stamped=${Number(stamp.numAffectedRows ?? 0)}`)
}

/**
 * Deliberately a NO-OP down migration — identical reasoning to `zzzz20260823100000`'s down(): this
 * migration adds no schema object, and a reverse UPDATE cannot distinguish a value THIS migration
 * wrote from one a later writer wrote for the same row afterward, so it would risk destroying
 * load-bearing tenant pins written by ordinary product usage after this migration applied.
 */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty — see doc comment above.
}
