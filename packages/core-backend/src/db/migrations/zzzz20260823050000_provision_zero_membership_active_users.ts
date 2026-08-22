import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * Lock-11 (writer-org-derivation) — D-8(β) provisioning: admit the 12 zero-membership ACTIVE
 * users into the single active org, ahead of both this repo's Migration B revision and every
 * arm-(a) writer slice.
 *
 * Ratified design: docs/development/approval-lock11-writer-org-derivation-20260822.md, §10
 * (Ratification block, owner sixth by-reference reply, 2026-08-22), resolution-table row
 * "D-8 + 269 rows": "(β), ordering half as the body defines it (:1458): the provisioning step
 * lands BEFORE any writer slice, so the population is empty when the arms land — concretely,
 * provision the 12 zero-membership active users into the single org + (i)-guarded: Migration B's
 * class-6 disposition revised to 'backfill the unique org IFF exactly one active org exists
 * repo-wide, else ABORT as ruled' — the single-org premise self-asserted INSIDE the migration,
 * FAIL-LOUD retained". §10.2's "Binding ordering" clause: "the D-8(β) provisioning migration must
 * be MERGED ... before any arm-(a) writer slice merges ... Migration B's own position is
 * therefore ON the (β) side of the fence: it ships WITH the provisioning step, ahead of every
 * writer slice."
 *
 * WHY THIS FILE IS ORDERED BEFORE `zzzz20260823100000_backfill_approval_instance_org_id.ts`
 * (the revised Migration B), not after: §2.8 of the Lock-11 draft establishes that every
 * self-registered and every DingTalk-provisioned user holds zero active `user_orgs` memberships
 * by deliberate design. Some of those same zero-membership users are ALSO the unresolvable
 * requester on a Lock-10 §2.2(b) class-6 TERMINAL `approval_instances` row (class 6's own
 * predicate excludes any row whose requester resolves to exactly one active org membership).
 * Running this migration FIRST means Migration B's class-3 (requester-resolvable) backfill sees
 * the newly-provisioned membership and resolves those rows via the ORDINARY per-requester class-3
 * path, ahead of and in preference to the class-6 single-org stamp — i.e. provisioning-first
 * makes MORE rows resolve to their own requester's org (the finer-grained, already-ratified
 * class-3 mechanism) and correspondingly SHRINKS the population left for class 6's single-org
 * fallback, rather than the other way around. Reversing the order would still be correct under
 * the (i)-guard (both migrations independently re-read `user_orgs` and re-assert the single-org
 * premise), but would waste the opportunity to resolve those rows via class 3 specifically.
 *
 * POPULATION: `users.id` for every row with `users.is_active = true` that holds NO active
 * `user_orgs` membership (`D-9`-ruled single-`is_active` liveness predicate — byte-agreement with
 * the reader's `viewerActiveOrgIds`, `approval-instance-readability.ts:152-157`, and with this
 * same PR's revised Migration B class-3/class-6 predicates). Measured at ratification time as
 * `u1b_zero_membership_active_users=12` (evidence run 32568321791, `main`, archived per §10's
 * "Evidence the rulings rest on" line) — this migration is idempotent and NOT EXISTS-scoped, so
 * it re-measures and re-applies against whatever the population is AT MIGRATION TIME, not the
 * number 12 itself; the number is provenance, not a hardcoded bound.
 *
 * SINGLE-ORG PREMISE, SELF-ASSERTED, FAIL-LOUD (the "(i)-guard") — CHECKED ONLY WHEN THERE IS A
 * POPULATION TO PROVISION: this migration provisions ALL 12 users into "the" org, which is only a
 * coherent operation when `user_orgs` names EXACTLY ONE distinct active org repo-wide — the
 * identical premise, and the identical measurement query (`SELECT DISTINCT org_id FROM user_orgs
 * WHERE is_active`, evidence workflow's `u1a_*` probes), that the revised Migration B's class-6
 * (i)-guard uses. The premise is asserted ONLY after a pre-flight population check finds at least
 * one zero-active-membership active user to provision (see the pre-flight comment in `up()` — an
 * unconditional premise check aborted every empty-DB CI lane in this PR's first cut; H42 pins the
 * fix). Once a population exists, if the premise does not hold (zero distinct active orgs — e.g.
 * `user_orgs` itself is empty but `users` is not, degenerate but must not silently
 * no-op-then-insert garbage — or two-or-more, meaning "the" org is not well-defined), this
 * migration ABORTS before any INSERT, values-free (org ids are never interpolated into the
 * error): the operator is told HOW MANY distinct active orgs were found, never WHICH ones.
 *
 * IDEMPOTENT, NON-RESURRECTING: same posture as the two precedent `user_orgs` backfills
 * (`zzzz20260114110000_create_user_orgs_table.ts`'s inline backfill and
 * `zzzz20260721150000_backfill_user_orgs_from_directory_links.ts`) — `NOT EXISTS` scopes the
 * INSERT's source set to users with NO active membership row (so an already-membered user,
 * active OR already-deactivated by a later unbind, is left completely untouched — no UPDATE
 * branch, no re-activation), and `ON CONFLICT (user_id, org_id) DO NOTHING` is a second,
 * belt-and-suspenders idempotence guard against re-running this migration's own effect (or racing
 * a live writer that inserts the identical row between this migration's SELECT and its INSERT).
 * Re-running this migration is a no-op once every previously-zero-membership active user has a
 * membership row.
 *
 * MUTATION-MEASURED, not merely argued (three mutations, real-DB, `.db.test.ts` gates H32-H37,
 * H41; local Postgres 15.17, see this PR's evidence for the postgres:16/postgres:15-alpine
 * caveat):
 *   - dropping the single-org `if (activeOrgs.rows.length !== 1)` guard entirely (always
 *     proceed) reds EXACTLY H34 (the two-org fixture) — nothing else. Isolated, load-bearing.
 *   - dropping `ON CONFLICT (user_id, org_id) DO NOTHING` reds EXACTLY H41 — nothing else. H41 is
 *     the one shape where it matters: a user's ONLY row is a DEACTIVATED membership to the org
 *     that turns out to be the single active org. Without `DO NOTHING` the INSERT hits that row's
 *     PRIMARY KEY and Postgres raises a raw `23505 unique_violation`, aborting the whole
 *     migration transaction instead of the intended silent, non-resurrecting no-op.
 *   - dropping the `NOT EXISTS` population filter (INSERT `WHERE u.is_active = TRUE` alone, no
 *     membership check) leaves the suite **47/47 GREEN — CONDITIONALLY INERT**, not a coverage
 *     gap: under the (i)-guard every EXISTING active membership row already names the single
 *     resolved org (that is what "single active org" means), so re-selecting an already-membered
 *     user and re-attempting their exact `(user_id, theOrgId, true)` row is caught by `ON
 *     CONFLICT DO NOTHING` with an IDENTICAL final result. Same weaker-category shape as the
 *     revised backfill migration's own m28 (`SELECT DISTINCT`, conditionally inert because its
 *     argument leans on a DIFFERENT statement having already run) — here the argument leans on
 *     the single-org premise already having been asserted by the guard above it, not on this
 *     clause's own structure. `NOT EXISTS` is NOT dead code: it is what makes the population
 *     scoping self-documenting and keeps the INSERT's source set small (one un-provisioned user,
 *     not every active user in the org repeatedly), and it is the clause that decides WHICH rows
 *     even reach `ON CONFLICT` in the first place — but its removal is not independently
 *     red-provable given the guard and `ON CONFLICT` already present. Disclosed rather than
 *     forced into a fake-discriminating fixture.
 *
 * RESIDUAL NOT CLOSED BY THIS MIGRATION (found by H41's own construction, disclosed rather than
 * "fixed" — fixing it would mean `DO UPDATE SET is_active = true`, a resurrection this file's own
 * non-resurrecting posture and the `zzzz20260721150000` precedent both forbid): a U1b-population
 * user whose ONLY `user_orgs` row is a DEACTIVATED membership to what turns out to be the single
 * active org is NOT provisioned by this migration — `ON CONFLICT ... DO NOTHING` deliberately
 * leaves their row exactly as a prior unbind/deactivation left it. They remain zero-ACTIVE-
 * membership after this migration runs. This is a possible (not confirmed) shape for some subset
 * of the ratified "12" — nothing in `u1b`'s own probe SQL distinguishes "no row at all" from "a
 * deactivated row", so which of the 12 (if any) are this shape is unmeasured. The acceptance
 * signal is therefore NOT "12 rows appeared" but **`u1b_zero_membership_active_users` re-measured
 * post-deploy** (the same evidence-dispatch probe this PR's acceptance already uses) — if it does
 * not reach 0, this is the disclosed, expected reason, not a new defect.
 *
 * NOT applied to a user whose `users.is_active = false`: unlike the two precedent backfills
 * (which are deliberately NOT filtered by `users.is_active`, matching every LIVE writer's
 * "membership existence is written as active regardless of the user's own active flag" posture),
 * THIS migration is instructed by D-8(β) to close exactly the "zero-membership ACTIVE users"
 * class named in the ratification and by U1b's probe SQL (`WHERE u.is_active AND NOT EXISTS
 * (...)`), so it is intentionally narrower than its precedents: a currently-inactive user gains no
 * membership from this migration, matching the ratified scope (§10.1: "the ratified list scoped
 * this ruling to the CURRENT 12").
 *
 * SCHEMA: zero schema change (no column, no index, no constraint) — pure data migration, guarded
 * on both `users` and `user_orgs` existing (a fresh DB, or one where `zzzz20260114110000` has not
 * landed yet, skips cleanly rather than throwing).
 *
 * CI POSTURE: this migration is NOT added to any `MIGRATION_EXCLUDE` list and runs in every CI
 * lane's `db:migrate` step, including on an EMPTY database (`users` and `user_orgs` both exist,
 * both zero rows). The pre-flight population check above is what keeps that case a harmless
 * no-op: population = 0, early return, the single-org premise is never evaluated — CI's `users`
 * table having zero active rows means `user_orgs` also has zero distinct active orgs, which would
 * otherwise trip the FAIL-LOUD guard on every fresh-DB CI lane in this repo. Pinned by **H42**.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const hasUsers = await checkTableExists(db, 'users')
  const hasUserOrgs = await checkTableExists(db, 'user_orgs')
  if (!hasUsers || !hasUserOrgs) return

  // PRE-FLIGHT POPULATION CHECK (required for CI-safety on an empty/fresh DB — found by CI, not
  // by this migration's own real-DB suite; see H42). The single-org premise below is only a
  // meaningful, assertable REQUIREMENT when this migration would actually WRITE something. On an
  // empty database (every CI lane's `db:migrate` step, a fresh schema with zero `users` rows)
  // there is nothing to provision, `user_orgs` legitimately names ZERO distinct active orgs, and
  // this migration MUST be a safe no-op there — exactly the same "population-first, premise-
  // second" shape the revised backfill migration's own class-6 arm uses (`if (n > 0) { ...assert
  // premise... }`), applied here to fix a real gap in the FIRST cut of this file: an unconditional
  // premise check aborted `db:migrate` on every empty-DB CI lane (`approval-realdb-org-backfill-b`
  // and `migration-prod-image-parity (postgres:15-alpine)` both caught this live).
  const population = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM users u
     WHERE u.is_active = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE
       )
  `.execute(db)
  if (Number(population.rows[0]?.n ?? '0') === 0) return

  // Single-org premise, self-asserted, FAIL-LOUD (values-free) — see docblock. Read via the exact
  // set (not just the count) so the resolved org id is a value THIS migration observed, never a
  // second, independently-timed query racing the first.
  const activeOrgs = await sql<{ org_id: string }>`
    SELECT DISTINCT org_id FROM user_orgs WHERE is_active = TRUE
  `.execute(db)
  if (activeOrgs.rows.length !== 1) {
    throw new Error(
      `provision_zero_membership_active_users (Lock-11 D-8(β)) aborted before any INSERT: found ` +
      `${activeOrgs.rows.length} distinct active org(s) in user_orgs; exactly one is required to ` +
      `safely provision zero-membership active users into a single org (the (i)-guard). Org ids ` +
      `are NOT interpolated (values-free discipline).`,
    )
  }
  const theOrgId = activeOrgs.rows[0]!.org_id

  const result = await sql`
    INSERT INTO user_orgs (user_id, org_id, is_active)
    SELECT u.id, ${theOrgId}, true
    FROM users u
    WHERE u.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE
      )
    ON CONFLICT (user_id, org_id) DO NOTHING
  `.execute(db)

  // eslint-disable-next-line no-console
  console.log(`[provision-zero-membership-active-users] provisioned=${Number(result.numAffectedRows ?? 0)}`)
}

/**
 * Deliberately a NO-OP down migration — same shape and same reasoning as
 * `zzzz20260721150000_backfill_user_orgs_from_directory_links.ts:62-72` and this same PR's
 * revised `zzzz20260823100000_backfill_approval_instance_org_id.ts` down(): this is a repair
 * backfill, not a schema change, and there is no way to tell a `user_orgs` row THIS migration
 * inserted apart from one a later live writer (bind, admit, auto-match, or an operator's own
 * membership grant) legitimately inserted for the exact same (user_id, org_id) pair afterward, so
 * "undoing" it by DELETE would risk deleting real, currently-load-bearing membership rows created
 * by ordinary product usage after this migration applied. Session design authority; the lock is
 * silent on down() for a pure backfill.
 */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty — see doc comment above.
}
