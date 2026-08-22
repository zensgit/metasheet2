import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

/**
 * Lock-10 (S1) instance-readability — org anchor, MIGRATION B: ordered backfill of the RESIDUAL
 * NULL population left after Phase 1 (`zzzz20260821100000_add_approval_instance_org_id.ts`).
 *
 * Ratified design: docs/development/approval-lock10-instance-readability-20260821.md, §2.2(b)
 * (SIX ORDERED row classes, verbatim quoted below) and §5.1.1 arm (c-i)
 * (OD-S1-17(c), makes class 3's test well-defined). Authorization: owner fifth by-reference reply
 * (`/goal 按建议执行`, 2026-08-22), closeout item "Migration B(带前缀护栏)".
 *
 * THIS IS NOT A RE-RUN OF PHASE 1. Kysely never re-executes a recorded migration; the Phase-1
 * FILE never re-runs. This is a NEW migration over the rows Phase 1 left NULL, and it fixes a
 * proven gap in that file: Phase 1's class-2 UPDATE carries NO id-prefix guard, so a `plm:` or
 * `afs:` mirror row that happens to carry a bound attachment WOULD be stamped with an org — against
 * OD-S1-18(b) (class 5 / `plm:` stays NULL permanently) and against the ABORT-not-default posture
 * ruled for class 4 / `afs:` once implemented. This migration's class-2 UPDATE (§ CLASS 2 below)
 * is Phase 1's UPDATE plus the two prefix guards; it targets ONLY rows Phase 1 left NULL
 * (`i.org_id IS NULL`), so it is additive repair, not a re-execution of anything already recorded.
 *
 * ============================================================================================
 * LOCK-10 §2.2(b) — SIX ORDERED ROW CLASSES (verbatim preamble):
 *
 *   "The classes are ORDERED, and the order is normative (review P2-5, closed). They are not a
 *   menu of independently-true predicates: an instance can match several, and picking the 'wrong'
 *   source is not cosmetic, because after OD-S1-10 the instance org pin is what governs
 *   attachment downloads on a shipped route. The migration evaluates class 1 first, then 2, 3, 4,
 *   5, and where the first matching class disagrees with a later one it FAILS LOUD rather than
 *   choosing; specifically, a template-originated instance whose attachments carry a different
 *   org_id is a migration abort, not a silent re-tenanting. FAIL-LOUD is therefore a rule about
 *   cross-class conflict, not only about the attachment-vs-attachment case the draft originally
 *   covered."
 *
 *   1. TEMPLATE-ORIGINATED — `template_id IS NOT NULL`. Backfill source: the template's owning
 *      org. NO SOURCE EXISTS AT THIS BASELINE: `approval_templates` carries no org column in any
 *      migration (only `category`, `visibility_scope`, `sla_hours` were ever added to it — see
 *      Phase 1's docblock, and independently re-verified here). This migration therefore emits NO
 *      SQL for class 1 and needs no `checkTableExists('approval_templates')` guard — do not add
 *      one. A class-1 row is excluded from class 6 by class 6's OWN predicate
 *      (`template_id IS NULL`), so it stays NULL and does not abort; it MAY still be stamped by
 *      class 3 below via ordered fall-through (class 3 carries no `template_id` filter).
 *   2. ATTACHMENT-BEARING — `EXISTS (SELECT 1 FROM approval_attachments att WHERE
 *      att.instance_id = i.id)`. Backfill source: `att.org_id`. Cross-attachment conflict on the
 *      SAME instance is FAIL LOUD.
 *   3. REQUESTER-RESOLVABLE — `requester_snapshot->>'id'` resolves to EXACTLY ONE active org
 *      membership (OD-S1-17(c) arm (c-i), see below). Backfill source: the requester's org AT
 *      MIGRATION TIME, not at creation time (honest limit, unchanged by (c-i)).
 *   4. AFTER-SALES BRIDGE MIRRORS — `afs:`-prefixed ids, `template_id IS NULL`, written by
 *      `AfterSalesApprovalBridgeService`. Backfill source: "class 1/2/3 in order, then the
 *      deploy's org for the after-sales channel" — NOT WIRED ANYWHERE in this repo. DEFERRED —
 *      see CLASS 4 below.
 *   5. PLM MIRRORS — `plm:`-prefixed ids, `COALESCE(source_system,'platform') <> 'platform'`,
 *      written by `upsertPlmMirror`. Backfill source: NONE EXISTS (OD-S1-9(c-iii) + OD-S1-18) —
 *      permanently NULL.
 *   6. TERMINAL — platform id AND `template_id IS NULL` AND zero attachments AND requester not
 *      resolving to exactly one active org membership. Backfill source: NONE. Ruled: the
 *      migration ABORTS and reports the offending ids (this migration reports CARDINALITY ONLY —
 *      see the DISCLOSED DEVIATION paragraph below); it does not invent an org and does not leave
 *      the row NULL silently past an operator's notice.
 *
 * §5.1.1 arm (c-i) (OD-S1-17(c), verbatim excerpt): "the org half of the predicate is a union over
 * the viewer's ACTIVE org memberships ... Migration consequence: §2.2(b) class 3's identifying
 * test ('resolves to exactly one active org membership') is now well-defined — a multi-org
 * requester FAILS class 3 and falls through the ordered table under the unchanged
 * FAIL-LOUD/terminal-ABORT discipline. The class-3 declared limit ('can move a historical instance
 * out of the tenant that ran it') is NOT diminished by (c-i)."
 *
 * §5.1.2: P2-1 — the org pin ships DORMANT (own flag, own activation step, staging then prod);
 * untouched by this migration. P2-2(b) — phase 3 (`SET NOT NULL` / the presence CHECK) is a NAMED
 * FOLLOW-UP SLICE requiring its OWN authorization. THIS MIGRATION ADDS NO CHECK AND NO NOT NULL.
 * `approval_instance_org_nonblank` (Phase 1's constraint) is left completely untouched.
 * ============================================================================================
 *
 * CLASS_6_PREDICATE — reproduced VERBATIM in THREE places: this comment, the pre-flight census
 * query in up() below, and the `c6_terminal_org_null` probe added to
 * `.github/workflows/approval-s1-org-backfill-evidence.yml` in this same PR. If the three ever
 * diverge, a green evidence probe stops predicting a green migration — see that workflow's header.
 *
 *   i.org_id IS NULL
 *   AND i.id NOT LIKE 'plm:%'
 *   AND i.id NOT LIKE 'afs:%'
 *   AND COALESCE(i.source_system, 'platform') = 'platform'
 *   AND i.template_id IS NULL
 *   AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
 *   AND NOT EXISTS (
 *     SELECT 1 FROM user_orgs uo
 *      WHERE uo.user_id = i.requester_snapshot->>'id'
 *        AND uo.is_active = TRUE
 *      GROUP BY uo.user_id
 *     HAVING count(*) = 1
 *   )
 *
 * The class-2 conflict abort and the class-6 abort are PROVABLY DISJOINT (conflict requires >= 1
 * attachment; class 6 requires zero), so the two messages can never be confused in an incident.
 *
 * MUTATION-COVERAGE HONESTY NOTE — CORRECTED (fix round, independent gate report
 * `/tmp/migb-gate-20260822.md`, head `b6309c7486`): an earlier version of this note claimed
 * exactly ONE coverage gap (this class-6 predicate's `i.id NOT LIKE 'plm:%'` clause). That claim
 * was false — a subsequent independent gate found THREE MORE, undisclosed, in different clauses
 * of this same migration:
 *   - `uo.is_active = TRUE`, untested in BOTH the class-3 subquery (line ~290) AND this class-6
 *     subquery (line ~205) — decisive for 257 of prod's 271 residual rows (see H18/H19/H20 in
 *     `.db.test.ts`).
 *   - the `afs:` prefix guard on the class-3 UPDATE (line ~297) — unlike the `plm:` case, class 3
 *     carries NO `source_system` filter, so this guard was the ONLY thing enforcing the
 *     ABORT-not-default posture for class 4 there, and it had no test (see H21).
 *   - the class-2 conflict census's OWN `plm:`/`afs:` prefix guards (lines ~233-234) — untested;
 *     a regression would false-positive FAIL-LOUD the whole migration over a row it should never
 *     touch (see H23/H24).
 * All three, plus the originally-disclosed gap, are now closed with red-proving fixtures in
 * `.db.test.ts` (H18-H26) — including H26, a SYNTHETIC `plm:` id with `source_system='platform'`
 * (not `upsertPlmMirror`'s real shape, but not forbidden by anything in this schema), built
 * specifically to exercise this predicate's `i.id NOT LIKE 'plm:%'` clause independent of the
 * `source_system` clause, since no real writer in this codebase is known to produce that
 * combination. As of this fix round every clause of every predicate and every UPDATE in this file
 * has a red-proving fixture that was actually run (whole-file, not name-filtered) and actually
 * reds under the corresponding single-line deletion — none are cited as load-bearing by inspection
 * alone. See the mutation table in this PR's body for the full re-measured cross-reference.
 *
 * ROWS THAT LEGITIMATELY STAY NULL AFTER THIS MIGRATION, NO ABORT (enumerated, not asserted as
 * exhaustive by a CHECK — Phase 3 is a separate slice):
 *   - `plm:` / `afs:` prefixed ids (classes 5 / 4).
 *   - `template_id IS NOT NULL` AND requester unresolvable (class-1 residue — no source exists).
 *   - `COALESCE(source_system,'platform') <> 'platform'` without a `plm:`/`afs:` prefix, AND the
 *     requester does NOT resolve to exactly one active `user_orgs` membership (outside class 5 and
 *     outside class 6's platform predicate). CORRECTED (fix round): an earlier draft of this
 *     bullet omitted the "AND unresolvable" qualifier, implying this shape unconditionally stays
 *     NULL. It does not — class 3 carries NO `source_system` filter, so a row on this shape WITH a
 *     uniquely-resolvable requester IS stamped by class 3 (see H25 in `.db.test.ts`, e.g.
 *     `source_system='erp'`, unprefixed, resolvable requester -> stamped from the requester's org).
 *
 * DISCLOSED DEVIATION from §2.2(b)'s class-6 text ("ABORTS and reports the offending ids"): this
 * migration reports CARDINALITY ONLY, never an instance id, following the VALUES-FREE DISCIPLINE
 * established by `approval-s1-org-backfill-evidence.yml` ("approval_instances.org_id values are
 * tenant labels and instance ids are record identifiers; neither is ever selected, echoed, or
 * interpolated into an error") and that same workflow's own p40 probe, which deliberately reports
 * the cardinality of Phase 1's (id-interpolating) conflict predicate rather than replaying the
 * id-interpolation itself. Framed the same way `approval-instance-readability-s1.db.test.ts:23-33`
 * frames its org-pin default-OFF posture: a disclosed DEVIATION from the lock's text, not a silent
 * narrowing. To enumerate the offending ids, an operator re-runs the CLASS_6_PREDICATE above (or
 * the workflow's `c6_terminal_org_null` probe SQL, which is the same predicate) directly against
 * the target database with a SELECT instead of a COUNT — this migration file never does that
 * itself.
 *
 * IDEMPOTENCY / REPLAY: every UPDATE below is scoped `AND i.org_id IS NULL` (P3-3 precedent,
 * `zzzz20260821100000:112-120`), so a row this migration (or an earlier one) already stamped is
 * untouched by a re-run, and a re-run of this migration's OWN body is a no-op on its own output.
 * Both pre-flight censuses are ALSO `org_id IS NULL`-scoped, so a conflict/terminal match on a row
 * this migration would never touch cannot abort the whole run.
 *
 * TRANSACTIONAL POSTURE: kysely wraps migration execution in a transaction on the Postgres
 * dialect, and both aborts below throw BEFORE any UPDATE runs, so an abort here leaves zero
 * partial writes. No nested transaction is opened.
 *
 * GUARDS (all three are REQUIRED, not defensive):
 *   - `checkColumnExists(db, 'approval_instances', 'org_id')`: `packages/core-backend/src/db/
 *     migrate.ts:32` sets `allowUnorderedMigrations: true`, so this migration's name CAN be
 *     recorded on a database where Phase 1 has not yet added the column — an early return here is
 *     what keeps that a safe no-op instead of a crash. Honesty note: in that (currently
 *     hypothetical — Phase 1 is in no `MIGRATION_EXCLUDE` list and every lane runs it) unordered
 *     case, this guard degrades to a PERMANENT no-op for this migration's row: this migration gets
 *     recorded as applied, Phase 1 later adds the column, and this backfill never runs again
 *     (kysely will not re-run it by name). That is acceptable only because it is safe on a fresh
 *     DB (zero rows) and Phase 1 is not excluded anywhere today; it is not a general guarantee.
 *   - `checkTableExists(db, 'approval_attachments')`: same three-independent-exclusion-mechanism
 *     rationale as Phase 1's identical guard (`migration-provider.ts:21-59`).
 *   - `checkTableExists(db, 'user_orgs')`: NEW and load-bearing for this migration.
 *     `zzzz20260114110000_create_user_orgs_table.ts` IS in `MIGRATION_EXCLUDE` for
 *     `observability-strict.yml:134`, `observability-e2e.yml:103`, `safety-guard-e2e.yml:98`,
 *     `migration-replay.yml:104/111`. Without this guard those lanes hard-error on a missing
 *     relation even at zero rows.
 *
 * CI POSTURE: this migration is NOT added to any `MIGRATION_EXCLUDE` list and runs in every CI
 * lane's `db:migrate` step, including on an EMPTY database. On an empty `approval_instances` every
 * census below returns 0 (no abort) and every UPDATE matches 0 rows — harmless no-ops. The ONLY
 * way this migration can hard-error on an empty DB is a missing relation, which is exactly what
 * the three guards above exist to prevent.
 *
 * W4C-0 DML CENSUS: `approval_instances` is a `shared_hook`-bucket table
 * (`scripts/attendance/w4c0-dml-inventory/table-classification.cjs`); this file's UPDATEs are
 * claimed by a NEW `GENERIC_SHARED_ALLOWLIST` row keyed by this file's relPath in
 * `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs` (added in this same PR) — the
 * allowlist is matched by relPath alone and does NOT inherit Phase 1's row.
 *
 * No index added here (Phase 1's "no index" reasoning applies unchanged); no down()-side data
 * reversal (see down() below for the full reasoning — session design authority, the lock is
 * silent on down()).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // See GUARDS above: allowUnorderedMigrations means this migration can run before Phase 1 has
  // added the column. If it hasn't, there is nothing to backfill yet.
  if (!(await checkColumnExists(db, 'approval_instances', 'org_id'))) return

  const hasAttachments = await checkTableExists(db, 'approval_attachments')
  const hasUserOrgs = await checkTableExists(db, 'user_orgs')

  const log = (line: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[approval-org-backfill-b] ${line}`)
  }

  // ------------------------------------------------------------------------------------------
  // CLASS 6 — TERMINAL pre-flight census + ABORT. Run BEFORE any UPDATE (mirrors Phase 1's own
  // conflict pre-flight ordering). Gated on BOTH `hasUserOrgs` and `hasAttachments`: without
  // `user_orgs` the "requester not resolving to exactly one active org" half of the predicate
  // degenerates (every row would vacuously satisfy "no matching membership"), which is a
  // DIFFERENT predicate, not a conservative approximation of this one — so the safer choice is to
  // skip the whole census rather than run a mis-shaped version of it. Same reasoning for
  // `approval_attachments` (the "zero attachments" clause).
  // ------------------------------------------------------------------------------------------
  if (hasUserOrgs && hasAttachments) {
    const class6 = await sql<{ n: string }>`
      SELECT count(*)::text AS n
        FROM approval_instances i
       WHERE i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
         AND COALESCE(i.source_system, 'platform') = 'platform'
         AND i.template_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
         AND NOT EXISTS (
           SELECT 1 FROM user_orgs uo
            WHERE uo.user_id = i.requester_snapshot->>'id'
              AND uo.is_active = TRUE
            GROUP BY uo.user_id
           HAVING count(*) = 1
         )
    `.execute(db)
    const n = Number(class6.rows[0]?.n ?? '0')
    if (n > 0) {
      throw new Error(
        `approval_instance_org_id backfill (Migration B) aborted before any UPDATE: ${n} instance(s) ` +
        `matched Lock-10 §2.2(b) class 6 (TERMINAL — no derivable org source). Instance ids are NOT ` +
        `interpolated (values-free discipline). To enumerate them, run the predicate reproduced in ` +
        `this file's CLASS_6_PREDICATE comment against the same database.`,
      )
    }
  }

  // ------------------------------------------------------------------------------------------
  // CLASS 2 — attachment-bearing, pre-flight FAIL-LOUD on cross-attachment-org conflict. Scoped
  // to `org_id IS NULL` (this migration's own write population), same P3-3 precedent as Phase 1.
  // ------------------------------------------------------------------------------------------
  if (hasAttachments) {
    const conflicts = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM (
        SELECT a.instance_id
          FROM approval_attachments a
          JOIN approval_instances i ON i.id = a.instance_id
         WHERE a.instance_id IS NOT NULL
           AND i.org_id IS NULL
           AND i.id NOT LIKE 'plm:%'
           AND i.id NOT LIKE 'afs:%'
         GROUP BY a.instance_id
        HAVING count(DISTINCT a.org_id) > 1
      ) c
    `.execute(db)
    const n = Number(conflicts.rows[0]?.n ?? '0')
    if (n > 0) {
      throw new Error(
        `approval_instance_org_id backfill (Migration B) aborted before any UPDATE: ${n} instance(s) ` +
        `whose bound attachments carry org_id values from more than one org (class-2 cross-class ` +
        `FAIL LOUD, OD-S1-9(b)). Instance ids are NOT interpolated (values-free discipline).`,
      )
    }

    // CLASS 2 backfill — Phase 1's UPDATE, PLUS the two prefix guards (the proven-mechanism fix:
    // without them a `plm:`/`afs:` row carrying a bound attachment would be stamped here).
    const class2Result = await sql`
      UPDATE approval_instances i
         SET org_id = a.org_id
        FROM (
          SELECT DISTINCT instance_id, org_id
            FROM approval_attachments
           WHERE instance_id IS NOT NULL
        ) a
       WHERE a.instance_id = i.id
         AND i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
    `.execute(db)
    log(`class2_stamped=${Number(class2Result.numAffectedRows ?? 0)}`)
  } else {
    log('class2_stamped=0')
  }

  // ------------------------------------------------------------------------------------------
  // CLASS 3 — requester-resolvable, under OD-S1-17(c) arm (c-i). No `template_id` filter: ordered
  // fall-through means a class-1 row unsourced by class 1 is eligible here. `HAVING count(*) = 1`
  // IS the (c-i)-ruled well-definedness test for "exactly one active org membership" — do NOT
  // "simplify" it to `>= 1`: (i) that would silently pick one org for a multi-org requester,
  // exactly the hole (c-i) closes, and (ii) it is also what makes `min(uo.org_id)` collation-safe
  // below (see next comment) — remove the HAVING and both properties are gone at once.
  // `min()` is safe here PRECISELY BECAUSE the group is a guaranteed singleton under the HAVING:
  // `min` never has to order two distinct values against each other, so its result is identical
  // under glibc and musl collation alike (relevant because prod runs PG15/musl-alpine-adjacent
  // libc while CI runs PG16/glibc — see this repo's `finding_prod_pg15_never_tested` memory). A
  // multi-org requester (>= 2 active memberships) and a zero-membership / `requester_snapshot`
  // `{}'`-default requester (JSONB NOT NULL DEFAULT '{}', `zzzz20260404100000:36/58/67` — so
  // `->>'id'` is NULL and `NULL = r.user_id` never matches) both fall through untouched.
  // ------------------------------------------------------------------------------------------
  if (hasUserOrgs) {
    const class3Result = await sql`
      UPDATE approval_instances i
         SET org_id = r.org_id
        FROM (
          SELECT uo.user_id, min(uo.org_id) AS org_id
            FROM user_orgs uo
           WHERE uo.is_active = TRUE
           GROUP BY uo.user_id
          HAVING count(*) = 1
        ) r
       WHERE r.user_id = i.requester_snapshot->>'id'
         AND i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
    `.execute(db)
    log(`class3_stamped=${Number(class3Result.numAffectedRows ?? 0)}`)
  } else {
    log('class3_stamped=0')
  }

  // ------------------------------------------------------------------------------------------
  // Counts-only reporting for classes 4 and 5 (DEFERRED / never-stamped — no statement emitted
  // for either) and the residual shapes enumerated in the docblock above. VALUES-FREE: every line
  // is an integer, never an id, an org value, or a requester id.
  // ------------------------------------------------------------------------------------------
  const class4 = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM approval_instances WHERE org_id IS NULL AND id LIKE 'afs:%'
  `.execute(db)
  log(`class4_afs_deferred_null=${class4.rows[0]?.n ?? '0'}`)

  const class5 = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM approval_instances WHERE org_id IS NULL AND id LIKE 'plm:%'
  `.execute(db)
  log(`class5_plm_null=${class5.rows[0]?.n ?? '0'}`)

  const class1Residue = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM approval_instances
     WHERE org_id IS NULL
       AND id NOT LIKE 'plm:%'
       AND id NOT LIKE 'afs:%'
       AND template_id IS NOT NULL
  `.execute(db)
  log(`class1_residue_null=${class1Residue.rows[0]?.n ?? '0'}`)

  const residualPlatform = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM approval_instances
     WHERE org_id IS NULL
       AND id NOT LIKE 'plm:%'
       AND id NOT LIKE 'afs:%'
       AND COALESCE(source_system, 'platform') = 'platform'
  `.execute(db)
  log(`residual_platform_null=${residualPlatform.rows[0]?.n ?? '0'}`)
}

/**
 * Deliberately a NO-OP down migration — same shape as
 * `zzzz20260721150000_backfill_user_orgs_from_directory_links.ts:63-72` (session design
 * authority; the lock is silent on down() for a pure backfill). Reasoning:
 *   (i) this migration adds no schema object, so there is nothing to drop — dropping the org_id
 *       column is Phase 1's inverse, not this migration's;
 *   (ii) setting stamped rows back to NULL cannot distinguish a value THIS migration wrote from
 *        one a later writer or a later migration wrote for the same row afterward, so a reverse
 *        UPDATE would risk destroying load-bearing tenant pins written by ordinary product usage
 *        after this migration applied — the identical argument
 *        `zzzz20260721150000`'s down() records;
 *   (iii) a `throw` here would wedge any legitimate rollback chain that passes through this name.
 * Marked as the safe arm, reversible on inspection.
 */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty — see doc comment above.
}
