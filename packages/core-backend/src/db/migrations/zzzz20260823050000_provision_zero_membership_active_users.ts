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
 * SINGLE-ORG PREMISE, SELF-ASSERTED, FAIL-LOUD (the "(i)-guard"): this migration provisions ALL
 * 12 users into "the" org, which is only a coherent operation when `user_orgs` names EXACTLY ONE
 * distinct active org repo-wide — the identical premise, and the identical measurement query
 * (`SELECT DISTINCT org_id FROM user_orgs WHERE is_active`, evidence workflow's `u1a_*` probes),
 * that the revised Migration B's class-6 (i)-guard uses. If the premise does not hold (zero
 * distinct active orgs — an empty `user_orgs`, degenerate but must not silently no-op-then-insert
 * garbage — or two-or-more, meaning "the" org is not well-defined), this migration ABORTS before
 * any INSERT, values-free (org ids are never interpolated into the error): the operator is told
 * HOW MANY distinct active orgs were found, never WHICH ones.
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
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const hasUsers = await checkTableExists(db, 'users')
  const hasUserOrgs = await checkTableExists(db, 'user_orgs')
  if (!hasUsers || !hasUserOrgs) return

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
