/**
 * W4-PRE-1b (owner CHANGES_REQUESTED on the W4 re-ratify PR #4522, 2026-07-21, item C):
 * real-stock backfill for `user_orgs`.
 *
 * W4-PRE-1 (#4521) and W4-PRE-1b (this line) closed every PRODUCTION write path that maintains
 * `user_orgs` going forward, but neither touched EXISTING data: a user who was admitted/bound to
 * a directory account BEFORE those write paths existed has an `active directory_account_links`
 * row (proof they belong to an org) yet may have no `user_orgs` row at all — exactly the "already
 * linked users may have no membership" half of the owner's P1 finding. This migration is the
 * one-time repair for that stock.
 *
 * Population: `directory_account_links.local_user_id` for every LINKED row whose
 * `directory_accounts` is active, joined through `directory_accounts.integration_id ->
 * directory_integrations.id` to resolve the KNOWN AUTHORITATIVE org — the exact same
 * (link_status='linked' AND directory_accounts.is_active=true) predicate the S7-5 readiness read
 * (`readOrgDirectoryReadiness`, attendance-admin.ts) and every bind-shaped writer in this line use
 * to mean "this account currently counts as bound". Never a client-supplied or guessed org.
 *
 * Idempotency + non-resurrection (owner: "绝不复活已 is_active=false 的行"): `ON CONFLICT (user_id,
 * org_id) DO NOTHING` — this migration ONLY inserts rows that do not exist yet. A row that already
 * exists, active OR already deactivated by the item-B unbind/rebind/archive logic, is left
 * completely untouched (no UPDATE branch at all, unlike the live bind writers' `DO UPDATE SET
 * is_active = EXCLUDED.is_active`). Re-running this migration (or running it against a DB where a
 * later sync/bind has already produced the row) is a no-op for every already-covered pair.
 *
 * Deliberately NOT filtered by `users.is_active` — same precedent as every live writer in this
 * line (admin-users.ts's W4-PRE-1 write, directory-sync.ts's admission/bind writers): membership
 * EXISTENCE is written as active regardless of the user's own active flag; the RD-3 dual-is_active
 * read filter (`user_orgs.is_active=true AND users.is_active=true`) is what excludes a deactivated
 * user from every count and gate, not a write-time filter here.
 *
 * Pure data migration — zero schema change, zero index change. `user_orgs` and its primary key
 * were already established by `zzzz20260114110000_create_user_orgs_table.ts`; this file only
 * needs `checkTableExists` guards for the SOURCE tables (`directory_account_links`,
 * `directory_accounts`, `directory_integrations`, `user_orgs` itself) so a fresh DB or a DB where
 * directory-sync tables have not landed yet skips cleanly instead of throwing.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const requiredTables = ['user_orgs', 'directory_account_links', 'directory_accounts', 'directory_integrations']
  for (const table of requiredTables) {
    if (!(await checkTableExists(db, table))) return
  }

  await sql`
    INSERT INTO user_orgs (user_id, org_id, is_active)
    SELECT DISTINCT l.local_user_id, i.org_id, true
    FROM directory_account_links l
    JOIN directory_accounts a ON a.id = l.directory_account_id
    JOIN directory_integrations i ON i.id = a.integration_id
    WHERE l.link_status = 'linked'
      AND l.local_user_id IS NOT NULL
      AND a.is_active = true
    ON CONFLICT (user_id, org_id) DO NOTHING
  `.execute(db)
}

/**
 * Deliberately a NO-OP down migration. This is a repair backfill, not a schema change — there is
 * no way to tell a row this migration inserted apart from one a later live writer (bind, admit,
 * auto-match) legitimately inserted for the exact same (user_id, org_id) pair after `up()` ran,
 * so "undoing" it by DELETE would risk deleting real, currently-load-bearing membership rows
 * created by ordinary product usage after this migration applied. `zzzz20260114110000`'s own
 * one-time backfill sets the same precedent (no reverse data migration).
 */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty — see doc comment above.
}
