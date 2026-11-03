/**
 * Slice C (issue #6079, plan "切片 C 开工", owner 2026-10-13 「做」): ONE read of a user's organization
 * membership history, shared by
 *   - the write-side guard in `createLocalAccount` (`refuseMembershipHistory`, set by
 *     `POST /api/admin/directory/local/accounts`), which refuses to create a local directory account
 *     — and so to run `upsertActiveUserOrgMembership` (revives a deactivated row) and
 *     `supersedeDeprovisionEvidenceForAccessGraphWrite` (marks applied evidence superseded) — for a
 *     user who already has a `user_orgs` row in that org or applied deprovision evidence; and
 *   - the read-only `organizations.hasAnyRow` / `organizations.deprovisionApplied` fields of
 *     `GET /api/admin/users/:userId/member-admission` (routes/admin-users.ts), which tell the admin
 *     panel whether that guard would refuse before it offers the "join the default organization"
 *     action.
 * Both callers run the SAME statement below, so the panel and the guard cannot disagree.
 *
 * Predicates:
 *   - `has_any_row` / `has_org_row`: ANY `user_orgs` row for the user (any org / the given org),
 *     active OR deactivated. A deactivated row is exactly what the upsert would silently revive; the
 *     2026-08-23 provisioning migrations (zzzz20260823040000 recovery09 :54-60 / :116-124 and
 *     zzzz20260823050000 :60-69 / :97-108) refuse to resurrect one for the same reason.
 *   - `deprovision_applied`: an event OR an effect for the user still in status 'applied' — the same
 *     "live evidence" test as the deny-row compensation path (deprovision-evidence-api.ts
 *     COMPENSATION_LIVE_EVIDENCE) and exactly the rows `supersedeDeprovisionEvidenceForAccessGraphWrite`
 *     would flip to 'superseded'. Applied evidence is undone only through the deprovision-evidence
 *     restore path (`POST /api/admin/directory/deprovision-events/:eventId/reactivate` |
 *     `/force-reactivate`), which reverses each recorded effect; a local account must not be a side
 *     door around it.
 *
 * Every value must come back as a boolean; anything else throws, so the guard fails closed (the
 * transaction rolls back) and the read-only caller degrades to `null` ("unknown").
 *
 * Consistency: the guard runs after `lockUsersForAccessGraphWrite` has taken the user's row lock
 * (the canonical access-graph mutex of access-graph-mutex.ts, which the bind / unbind / local-account /
 * deprovision / restore writers take before touching links, memberships or evidence), so the read
 * cannot interleave with such a writer for the same user. Writers outside that protocol (a migration,
 * the create-user insert for a brand-new user) are not serialised by it. The read-only caller takes no
 * lock; its answer is advisory and the guard remains the enforcement point.
 */

export type OrgMembershipHistoryClient = {
  query: (
    statement: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export interface OrgMembershipHistory {
  /** Any `user_orgs` row for the user, in any org, active or deactivated. */
  hasAnyRow: boolean
  /** Any `user_orgs` row for the user in the requested org, active or deactivated (false when no org was requested). */
  hasOrgRow: boolean
  /** An applied deprovision event or effect exists for the user. */
  deprovisionApplied: boolean
}

export const ORG_MEMBERSHIP_HISTORY_SQL = `SELECT
  EXISTS (
    SELECT 1 FROM user_orgs uo
     WHERE uo.user_id = $1::text
  ) AS has_any_row,
  EXISTS (
    SELECT 1 FROM user_orgs uo
     WHERE uo.user_id = $1::text
       AND uo.org_id = $2::text
  ) AS has_org_row,
  (
    EXISTS (
      SELECT 1 FROM directory_deprovision_events event
       WHERE event.local_user_id = $1::text
         AND event.status = 'applied'
    )
    OR EXISTS (
      SELECT 1 FROM directory_deprovision_effects effect
       WHERE effect.local_user_id = $1::text
         AND effect.status = 'applied'
    )
  ) AS deprovision_applied`

function requireBoolean(value: unknown): boolean {
  if (value === true || value === false) return value
  throw new Error('organization membership history read returned an unexpected shape')
}

export async function readOrgMembershipHistory(
  client: OrgMembershipHistoryClient,
  options: { userId: string; orgId: string | null },
): Promise<OrgMembershipHistory> {
  const result = await client.query(ORG_MEMBERSHIP_HISTORY_SQL, [options.userId, options.orgId])
  const row = result.rows[0]
  if (!row) throw new Error('organization membership history read returned no row')
  return {
    hasAnyRow: requireBoolean(row.has_any_row),
    hasOrgRow: requireBoolean(row.has_org_row),
    deprovisionApplied: requireBoolean(row.deprovision_applied),
  }
}
