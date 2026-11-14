/**
 * Directory link intent — the persisted shape of an administrator's explicit unbind.
 *
 * `unbindDirectoryAccount` records an explicit unbind on `directory_account_links` as
 * `(local_user_id = NULL, link_status = 'unmatched', match_strategy = 'manual_unbound')` and
 * keeps the reviewer columns for display. That combination is the durable intent: the account
 * stays unbound until an administrator binds or admits it again through a controlled action
 * (`bindDirectoryAccount`, `admitDirectoryAccountUser` and their batch variants), which
 * overwrite all of these columns deliberately.
 *
 * Every automatic writer — the identity-matching cascade (`resolveDirectoryIdentityMatch`),
 * the sync apply loop and its link upsert, auto-admission, and the preview counters — reads the
 * intent through this one predicate so the definition cannot drift between callers. The
 * predicate deliberately looks at these three columns only: `reviewed_by` being set is not
 * evidence of an unbind (bind and admit write it too), and `review_note` is a display mirror,
 * not a decision input.
 *
 * Kept in its own module (no import from `directory-sync.ts`) so the cascade, the preview and
 * the tests share it without a cycle.
 */

/** The `match_strategy` value `unbindDirectoryAccount` persists. Mirrored by the Web client. */
export const DIRECTORY_ADMIN_UNBOUND_MATCH_STRATEGY = 'manual_unbound'

export type DirectoryLinkIntentRow = {
  local_user_id: string | null
  link_status: string | null
  match_strategy: string | null
}

/**
 * True when the link row carries an administrator's explicit unbind that no automatic
 * strategy may undo. A row that is linked again, or that carries a local user, is not held
 * even if its strategy text still says `manual_unbound` (shape defence).
 */
export function isAdminUnboundDirectoryLink(
  link: DirectoryLinkIntentRow | null | undefined,
): boolean {
  if (!link) return false
  return (
    link.match_strategy === DIRECTORY_ADMIN_UNBOUND_MATCH_STRATEGY
    && link.link_status !== 'linked'
    && (link.local_user_id === null || link.local_user_id === undefined)
  )
}

/**
 * SQL form of `NOT isAdminUnboundDirectoryLink(existing row)`, for the sync's
 * `ON CONFLICT (directory_account_id) DO UPDATE ... WHERE` clause. Written as the NULL-safe
 * De Morgan expansion so a row whose `match_strategy` is NULL (older rows, fixtures) still
 * evaluates TRUE and keeps being updated; a plain `NOT (a = 'x' AND ...)` would yield NULL
 * for such rows and silently stop every update to them.
 *
 * PostgreSQL evaluates this clause against the latest committed version of the conflicting
 * row after locking it, so an unbind that commits between the sync's read of the link rows and
 * this write is still honoured without the sync taking row locks early.
 */
export const DIRECTORY_LINK_NOT_ADMIN_UNBOUND_SQL = `(
  directory_account_links.match_strategy IS DISTINCT FROM '${DIRECTORY_ADMIN_UNBOUND_MATCH_STRATEGY}'
  OR directory_account_links.link_status = 'linked'
  OR directory_account_links.local_user_id IS NOT NULL
)`
