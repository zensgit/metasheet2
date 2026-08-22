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
 * CLASS-6 REVISION (this same PR, second authorization): Lock-11 (writer-org-derivation) §10
 * (docs/development/approval-lock11-writer-org-derivation-20260822.md), owner SIXTH by-reference
 * reply (2026-08-22), resolution-table row "D-8 + 269 rows": "(β), ordering half as the body
 * defines it (:1458): the provisioning step lands BEFORE any writer slice, so the population is
 * empty when the arms land — concretely, provision the 12 zero-membership active users into the
 * single org + (i)-guarded: Migration B's class-6 disposition revised to 'backfill the unique org
 * IFF exactly one active org exists repo-wide, else ABORT as ruled' — the single-org premise
 * self-asserted INSIDE the migration, FAIL-LOUD retained". This ruling AMENDS the class-6 arm
 * only; classes 1-5 and their ORDER are untouched (byte-identical SQL — see the per-class diff
 * note in the MUTATION-COVERAGE HONESTY NOTE below). The companion provisioning migration
 * `zzzz20260823050000_provision_zero_membership_active_users.ts` is ordered BEFORE this file
 * (lower timestamp) per §10.2's binding ordering and this file's own class-3-resolves-more-rows
 * justification (see that file's docblock).
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
 *      resolving to exactly one active org membership. Backfill source, AS REVISED by Lock-11 §10
 *      D-8(β) (see "CLASS-6 REVISION" above): IFF exactly one distinct active org exists
 *      repo-wide (`user_orgs.is_active`-scoped, self-asserted inside this migration), that org —
 *      the terminal rows ARE backfilled with it. If the single-org premise does NOT hold (zero or
 *      more than one distinct active org), the original ruling governs unchanged: the migration
 *      ABORTS and reports the offending CARDINALITY ONLY (see the DISCLOSED DEVIATION paragraph
 *      below, which still applies to this abort arm verbatim); it does not invent an org and does
 *      not leave the row NULL silently past an operator's notice in either arm.
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
 * CLASS_6_PREDICATE — reproduced VERBATIM in FOUR places (UPDATED at the D-8(β) revision, was
 * THREE): this comment, the pre-flight census query in up() below, this same up()'s class-6 STAMP
 * UPDATE's WHERE clause (new at the D-8(β) revision — see "CLASS-6 REVISION" above; it must select
 * exactly the rows the census counted, or the stamped row-count and the reported cardinality would
 * silently diverge), and the `c6_terminal_org_null` probe in
 * `.github/workflows/approval-s1-org-backfill-evidence.yml`. If any of the four ever diverge, a
 * green evidence probe stops predicting a green migration — see that workflow's header.
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
 * MUTATION-COVERAGE HONESTY NOTE — CORRECTED AGAIN (fix round 3, requalification report
 * `/tmp/migb-requal-20260822.md`, head `c8c7a22d508e97aba757f84ec1fb933a63f75f6d`): the PREVIOUS
 * version of this note (fix round 2) claimed "every clause of every predicate and every UPDATE in
 * this file has EITHER a red-proving fixture … OR is documented below as PROVABLY INERT" and "TWO
 * CLAUSES ARE PROVABLY INERT". BOTH claims were false, in three independent ways, found by an
 * independent requalification of that exact text (not a new behavioural defect — the SQL below is
 * UNCHANGED for the THIRD consecutive round; comment-stripped diff proves it):
 *   (1) the class-3 UPDATE's own correlation predicate `r.user_id = i.requester_snapshot->>'id'`
 *       had NO red-proving fixture and is NOT inert — it is the single most load-bearing clause in
 *       the file (deleting it turns a requester-SCOPED backfill into a blanket cross-tenant
 *       stamp). Closed by H27/H28/H29 (mutation m26: replace only this condition's text with
 *       `TRUE`, `WHERE` and every sibling clause untouched — reds exactly H27+H28+H29, on BOTH
 *       engines; H29 in particular PROVES cross-tenant mis-ASSIGNMENT between two distinct
 *       requesters/orgs, not merely a wrong stamp on one row).
 *   (2) the inert-clause count was wrong: FOUR clauses are provably inert, not two (corrected
 *       enumeration below), and a fifth (class-2's `SELECT DISTINCT`) is CONDITIONALLY inert — a
 *       materially weaker claim previously omitted entirely.
 *   (3) the 22-mutation sweep was not the exhaustive sweep the prior claim required: three more
 *       clauses were covered but never measured/credited — the class-2 conflict census's OWN
 *       `org_id IS NULL` scope (mutation m23, reds H13), the class-6 subquery's OWN correlation
 *       `uo.user_id = i.requester_snapshot->>'id'` (mutation m25, reds H15), and the per-clause
 *       halves of the previously-compound mutation m14 (m14a, `plm:` guard only, reds H23; m14b,
 *       `afs:` guard only, reds H24) — and an entire CATEGORY of statements, everything this
 *       migration only LOGS, had no oracle whatsoever (disclosure category (C) below).
 *
 * SELF-SCAN FOLLOW-UP (same round 3, before any external re-review of the note above): drafting
 * the "every clause falls into one of three categories" sentence below is ITSELF exactly the kind
 * of absolute claim this note exists to be suspicious of, so it was mechanically re-tested against
 * six MORE clauses before publishing rather than asserted from the mutation table alone. Two were
 * genuine, undiscriminated gaps — not inert, not previously credited by any fixture:
 *   - the class-2 conflict census's own JOIN condition `i.id = a.instance_id` (mutation m33,
 *     `ON TRUE`): every existing fixture happened to seed at most one `approval_instances` row per
 *     attachment-bearing test, so a cross join could never introduce a WRONG join partner. Closed
 *     by **H30**: an ALREADY-STAMPED instance with two conflicting-org attachments, co-resident
 *     with a SEPARATE bare eligible instance — under the mutation the already-stamped instance
 *     "borrows" the bare instance's `org_id IS NULL` eligibility through the widened join and the
 *     whole migration false-aborts. Reds under m33, and — once written — turned out to ALSO be the
 *     correct fixture for the class-2 UPDATE's own analogous correlation `a.instance_id = i.id`
 *     (mutation m32; H30 reds this alongside the pre-existing H17), closing that gap too without a
 *     second bespoke fixture.
 *   - the conflict census's `count(DISTINCT a.org_id) > 1` (mutation m34, DISTINCT removed): no
 *     fixture had ever seeded TWO attachments sharing the SAME org on one instance, so the
 *     DISTINCT keyword was untested. Closed by **H31**: two same-org attachments on one instance
 *     → must NOT be flagged as a conflict, must be stamped from that shared org. Reds under m34,
 *     and (once written) turned out to also be caught by the class-6 `NOT EXISTS (attachments)`
 *     clause's HAVING-removal mutation (m19) and the conflict-count-collapse mutation (m17),
 *     credited in the table below.
 * Two more of the six were mechanical, not behavioural: the conflict census's `GROUP BY
 * a.instance_id` (m35) and the class-3 subquery's `GROUP BY uo.user_id` (m37) each make the
 * surrounding aggregate query SYNTACTICALLY INVALID when removed (Postgres errors — a column
 * appearing outside an aggregate without a GROUP BY) — this breaks essentially every test that
 * reaches that statement (31/37 and 30/37 respectively), not by design of a targeted fixture but
 * because the mutation cannot produce a running query at all. Disclosed as its own kind, not
 * folded into (A)'s "one fixture, one clause" framing. The remaining two of the six (the class-6
 * `NOT EXISTS (attachments)` clause's own correlation, mutation m36, and — already covered above —
 * m32/m33) were covered-but-uncredited, same pattern as (3) above; m36 reds H15.
 *
 * The sweep is now 38 measured mutations (m1-m37, m14 split into m14a/m14b), every one re-run
 * whole-file (not name-filtered), `cp`-restored and sha256-verified before and after each run,
 * identical red-sets on Postgres 16 and Postgres 15-alpine for all 38 — see the mutation table in
 * this PR's body for the full cross-reference. (Line numbers remain deliberately omitted in this
 * note for the same staleness reason as the prior round.)
 *
 * SCOPE OF THE CLAUSE-CATEGORY CLAIM BELOW — stated narrowly, on purpose, after the self-scan
 * above caught this note's OWN drafting mistake once already this round: the following applies to
 * every clause identified BY NAME in this note and in the PR body's mutation table (38 mutations),
 * not to an asserted-complete enumeration of every predicate/JOIN/GROUP BY in the file. Two
 * successive self-scans (fix round 3's own docblock claim, then a mechanical follow-up before
 * publishing it) each found clauses the previous pass had missed; a third pass might too. What
 * changed is that every clause named below is now MEASURED, not merely inspected — the categories
 * are true of what has been checked, and the checking is disclosed as ongoing, not closed:
 *   (A) RED-PROVING FIXTURE — a fixture reds under that clause's single-line deletion, measured
 *       whole-file on both target Postgres majors.
 *   (B) PROVABLY INERT (or, for one clause, CONDITIONALLY inert) — no fixture will ever red it
 *       because the query structure makes it logically unreachable, not merely untested; see the
 *       corrected FOUR-clause enumeration below, plus the one conditionally-inert clause.
 *   (C) LOG-ONLY, UNASSERTED, NO BEHAVIOURAL CONSEQUENCE — the four trailing counts-only census
 *       statements and the two `_stamped` counters emit to the deploy log and are read by nothing
 *       in this codebase.
 *   (D) MECHANICALLY COVERED BY SQL VALIDITY — removing the clause makes the surrounding query
 *       syntactically invalid, so virtually every test that reaches it reds by construction (m35,
 *       m37); not a targeted fixture, disclosed as its own kind.
 *
 * FOUR CLAUSES ARE PROVABLY INERT (CORRECTED — a prior draft of this note said TWO; that count was
 * wrong by at least two), not coverage gaps — no fixture will ever red them, because the query
 * structure makes them logically unreachable, not merely untested:
 *   - the class-2 conflict census's `a.instance_id IS NOT NULL`: the surrounding join is an INNER
 *     JOIN on `i.id = a.instance_id`; SQL's `NULL = x` is never TRUE, so a NULL `instance_id`
 *     already fails the join and can never reach this filter. Mutation m20 replaced only this
 *     condition's text with `TRUE` (`WHERE a.instance_id IS NOT NULL` → `WHERE TRUE`), keeping
 *     every other clause and the `WHERE` keyword itself untouched, isolating this one condition —
 *     37/37 green this round, confirming the clause is inert on its own, not as part of a compound
 *     change.
 *   - `min(uo.org_id)` vs `max(uo.org_id)` in the class-3 subquery (mutation m22): `HAVING
 *     count(*) = 1` forces every surviving group to be a singleton, so `min` and `max` of a
 *     one-element set are always equal by definition — not merely equal in every fixture tried,
 *     equal for ALL POSSIBLE inputs. 37/37 green, consistent with the in-file comment at the
 *     class-3 UPDATE explaining why `min()` is collation-safe here.
 *   - the class-2 UPDATE's inner subquery `WHERE instance_id IS NOT NULL` (mutation m24): the
 *     outer join condition `WHERE a.instance_id = i.id` already makes a NULL `instance_id` from
 *     this subquery unreachable, by the identical `NULL = x` argument as the first bullet — a
 *     DIFFERENT physical clause with the SAME mechanism, not a duplicate of that finding. 37/37
 *     green.
 *   - the class-6 subquery's `GROUP BY uo.user_id` (mutation m27): the subquery's own `WHERE
 *     uo.user_id = i.requester_snapshot->>'id'` already pins every surviving row to one `user_id`
 *     value, so the grouping is redundant with the correlation itself. Verified over four shapes
 *     (unique user, multi-membership user, absent user, NULL requester id) via direct SQL: grouped
 *     and ungrouped results are identical in all four, and 37/37 green under the mutation itself.
 *     (Contrast: the class-3 subquery's own `GROUP BY uo.user_id`, mutation m37, is NOT similarly
 *     inert — its own subquery has no per-row correlation to make the grouping redundant, so
 *     removing it makes the query invalid instead — category (D), not (B).)
 *
 * ONE CLAUSE IS CONDITIONALLY INERT (a separate and WEAKER category — do not fold it into the FOUR
 * above): the class-2 UPDATE's `SELECT DISTINCT instance_id, org_id` (mutation m28, `SELECT
 * DISTINCT` → `SELECT`) — 37/37 green, INCLUDING under H31's real duplicate-same-org attachment
 * pair (the exact shape this argument is about, previously only hypothetical). Any row reaching
 * this UPDATE has already passed the class-2 conflict census, so every attachment bound to it
 * shares one `org_id`; duplicate source rows therefore write the identical value with or without
 * `DISTINCT`. This is weaker than the four bullets above because the argument depends on a
 * DIFFERENT statement (the conflict census) having already run and thrown on any counter-example
 * first — it is not unreachable by this query's OWN structure the way the four above are.
 *
 * LOG-ONLY, UNASSERTED, NO BEHAVIOURAL CONSEQUENCE (disclosure category (C)): `up()` ends with four
 * counts-only census statements (`class4_afs_deferred_null`, `class5_plm_null`,
 * `class1_residue_null`, `residual_platform_null`) and two `_stamped` counters (`class2_stamped`,
 * `class3_stamped`), all logged via `console.log`. Between them these carry TWELVE predicate
 * clauses (`org_id IS NULL` x4, `id LIKE 'afs:%'`, `id LIKE 'plm:%'`, `id NOT LIKE 'plm:%'` x2,
 * `id NOT LIKE 'afs:%'` x2, `template_id IS NOT NULL`,
 * `COALESCE(source_system,'platform') = 'platform'`) plus the two counters — NONE read by anything
 * in this codebase; they exist for an operator tailing the deploy log, not for this migration's own
 * control flow. The suite has NO oracle for any of them: zero matches for a console spy, `vi.*`,
 * or any emitted key, by construction (the helper set has no way to observe a log line). Proven by
 * measurement, not merely by the absence of an oracle — THREE mutations (m29: the `class4` census
 * counts `id LIKE 'plm:%'` instead of `'afs:%'`, reporting the WRONG class entirely; m30: the
 * `class1Residue` census's four clauses collapsed to `WHERE TRUE` all at once; m31:
 * `class3_stamped` hardcoded to `999`, i.e. the log LIES about how many rows were written) all
 * leave the suite 37/37 GREEN. This is a CLEANER falsification than any category-(A) gap, because
 * it needs no mutation argument at all — the absence of an observation channel is sufficient on
 * its own. The honest fix is this disclosure, not a synthetic oracle: these statements have no
 * behavioural consequence, so spy-based assertions around them would test the harness, not the
 * migration — the values-free discipline this file applies to error messages applies here too,
 * only more strongly (these lines are cardinality-only already; they are simply unread by anyone).
 *
 * ROUND 5 — Lock-11 §10 D-8(β) REVISION (this same PR): unlike every round since round 2, the SQL
 * in this file DID change this round — deliberately, under a new owner authorization (see
 * "CLASS-6 REVISION" near the top of this docblock), not as a self-scan correction. The change is
 * SCOPED to class 6 only:
 *   - classes 1 (no SQL), 2, 3, 4 (no SQL), and 5 (no SQL) are BYTE-IDENTICAL to the pre-revision
 *     file — provable per-class, not merely by a whole-file diff, because each class's SQL
 *     template is a syntactically distinct `sql\`...\`` tag in this file; a per-tag diff against
 *     the pre-revision copy shows changes ONLY inside the class-6 `if (hasUserOrgs &&
 *     hasAttachments)` block (the census query's own template is untouched; a new template — the
 *     single-org-premise SELECT — and a new template — the class-6 STAMP UPDATE — are inserted
 *     between the (unchanged) census and the (unchanged, now conditionally-reached) ABORT throw).
 *   - the class-6 census predicate itself (what counts as TERMINAL) is UNCHANGED — same six
 *     clauses, same CLASS_6_PREDICATE text. What changed is only what happens to a TERMINAL row:
 *     previously, unconditional ABORT; now, ABORT IFF the single-org premise fails, else STAMP.
 * Two NEW clauses this round, both requiring their own mutation coverage (added to the sweep in
 * this same fix round, see this PR's suite and body for the updated mutation table):
 *   - the single-org guard `activeOrgs.rows.length === 1` (the `if`/`else` branch selector): a
 *     mutation that deletes this guard (always takes the stamp branch regardless of how many
 *     distinct active orgs exist) must RED under a two-distinct-active-org fixture that used to
 *     ABORT — the single-org-fixture-only fixtures cannot discriminate this guard, because for
 *     them the guarded and unguarded code paths behave identically.
 *   - the class-6 STAMP UPDATE's own WHERE clause (the fourth verbatim reproduction of
 *     CLASS_6_PREDICATE): covered by construction — any mutation to it changes EITHER which rows
 *     get stamped (wrong value on a resolvable-by-another-class row) or how many do (a
 *     row-count mismatch against the census's `n`), both of which are fixture-observable the same
 *     way every other UPDATE's WHERE clause in this file already is.
 * The provably-inert and conditionally-inert clause enumerations above are UNCHANGED by this
 * round (none of the four inert clauses or the one conditionally-inert clause live inside the
 * class-6 block), and likewise for disclosure category (C) — no new log-only statement was added.
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
 * itself. This DEVIATION paragraph describes the ABORT arm only (the branch reached when the
 * D-8(β) single-org premise does NOT hold). The STAMP arm (premise holds) reports nothing at all
 * beyond the SAME `class6_stamped=<n>` cardinality-only log line every other UPDATE in this file
 * already emits (`class2_stamped`, `class3_stamped`) — there is no id-shaped text to disclose a
 * deviation from in that arm, because it is a write, not a report.
 *
 * IDEMPOTENCY / REPLAY: every UPDATE below, INCLUDING the class-6 STAMP UPDATE added by the
 * D-8(β) revision, is scoped `AND i.org_id IS NULL` (P3-3 precedent,
 * `zzzz20260821100000:112-120`), so a row this migration (or an earlier one) already stamped is
 * untouched by a re-run, and a re-run of this migration's OWN body is a no-op on its own output.
 * Both pre-flight censuses are ALSO `org_id IS NULL`-scoped, so a conflict/terminal match on a row
 * this migration would never touch cannot abort the whole run.
 *
 * TRANSACTIONAL POSTURE: kysely wraps migration execution in a transaction on the Postgres
 * dialect, and both aborts below throw BEFORE any UPDATE runs (INCLUDING the class-6 STAMP
 * UPDATE added by the D-8(β) revision — the single-org premise is checked, and the `else` throw
 * taken, strictly before that UPDATE statement), so an abort here leaves zero partial writes. This
 * file now issues three UPDATEs on its happy paths (class-6 stamp, class 2, class 3), each
 * reached only past its own pre-flight check. No nested transaction is opened.
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
      // Lock-11 §10 D-8(β) revision (ratified 2026-08-22, owner sixth by-reference reply,
      // resolution-table row "D-8 + 269 rows"): class 6 is no longer an unconditional ABORT. The
      // single-org premise is SELF-ASSERTED INSIDE THIS MIGRATION (the exact same measurement the
      // companion provisioning migration `zzzz20260823050000_provision_zero_membership_active_
      // users.ts` uses for its own (i)-guard, and the same predicate the evidence workflow's
      // `u1a_distinct_active_orgs` probe reports): IFF `user_orgs` names EXACTLY ONE distinct
      // active org repo-wide, the terminal rows are backfilled with THAT org; otherwise the
      // FAIL-LOUD ABORT fires VERBATIM — unchanged text, unchanged values-free discipline — exactly
      // as the originally-ruled class 6 did before this revision.
      const activeOrgs = await sql<{ org_id: string }>`
        SELECT DISTINCT org_id FROM user_orgs WHERE is_active = TRUE
      `.execute(db)
      if (activeOrgs.rows.length === 1) {
        const theOrgId = activeOrgs.rows[0]!.org_id
        // CLASS_6_PREDICATE reproduced VERBATIM a fourth time (docblock / this file's own census
        // above / this UPDATE's WHERE / the evidence workflow's `c6_terminal_org_null` probe) — see
        // this file's CLASS_6_PREDICATE comment header, updated to name all four sites.
        const class6Stamp = await sql`
          UPDATE approval_instances i
             SET org_id = ${theOrgId}
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
        log(`class6_stamped=${Number(class6Stamp.numAffectedRows ?? 0)}`)
      } else {
        throw new Error(
          `approval_instance_org_id backfill (Migration B) aborted before any UPDATE: ${n} instance(s) ` +
          `matched Lock-10 §2.2(b) class 6 (TERMINAL — no derivable org source). Instance ids are NOT ` +
          `interpolated (values-free discipline). To enumerate them, run the predicate reproduced in ` +
          `this file's CLASS_6_PREDICATE comment against the same database.`,
        )
      }
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
