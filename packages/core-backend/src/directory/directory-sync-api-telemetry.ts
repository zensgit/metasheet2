/**
 * DT-PERF (roadmap §7.7 "Sync Performance") — make the directory-sync external API call
 * pattern OPS-VERIFIABLE.
 *
 * The pull walks the department tree and, for every UNIQUE user it sees, issues one
 * `topapi/v2/user/get` detail call (directory-sync.ts `fetchAllUsers`). On a 2,000-employee
 * tenant that is ~2,000 sequential HTTP round trips — the N+1 the roadmap targets. The fix
 * itself (prefer `user/list` fields, detail only when missing) is STAGING-GATED: it cannot be
 * proven here that `user/list` returns every field the sync reads, so this module does NOT
 * change WHICH fields are read. It only instruments the call pattern so an operator can SEE
 * the cost on the run record and later prove the staging fix helped (before/after
 * `externalUserDetailCalls`).
 *
 * Counters are per DIRECTORY-PULL client invocation — one increment per real call at the
 * `fetchAllDepartments` / `fetchAllUsers` call sites. They are folded into the sync run's
 * `stats` JSONB (see `summarizeDirectorySyncApiCalls`), which `summarizeRun` already returns
 * verbatim, so the counts reach the runs API/UI with no new surface.
 */

/** One counter per external directory-pull client call issued during a sync run. */
export interface DirectorySyncApiCallCounters {
  /** `department/listsub` pages (one per department visited in the BFS). */
  departmentListCalls: number
  /** `department/get` detail calls (dept-manager enrichment; one per department, best-effort). */
  departmentDetailCalls: number
  /** `user/listsub` pages (one per page per department; more pages = larger tenant). */
  userListPageCalls: number
  /**
   * `user/get` detail calls — THE N+1. One per UNIQUE user (deduped: a user in two
   * departments is fetched once). Compare against `accountsSynced`: when they are ~equal the
   * per-user detail fan-out is fully in play.
   */
  userDetailCalls: number
}

/** A fresh zeroed counter set for one sync run. */
export function createDirectorySyncApiCallCounters(): DirectorySyncApiCallCounters {
  return {
    departmentListCalls: 0,
    departmentDetailCalls: 0,
    userListPageCalls: 0,
    userDetailCalls: 0,
  }
}

/**
 * The stats-JSONB projection of the counters. Keys are prefixed `external*` so ops can see at
 * a glance these are network cost, not row counts.
 *
 * `externalDirectoryPullCalls` is the SUM OF THE FOUR PULL CATEGORIES above — deliberately NOT
 * named "total": it excludes the (cached) app-access-token fetch and the manual-run diagnostic
 * sample, which are not part of the per-user fan-out and whose logical-vs-HTTP count is
 * ambiguous. It is the honest aggregate of what the directory pull itself costs.
 */
export function summarizeDirectorySyncApiCalls(counters: DirectorySyncApiCallCounters): {
  externalDepartmentListCalls: number
  externalDepartmentDetailCalls: number
  externalUserListPageCalls: number
  externalUserDetailCalls: number
  externalDirectoryPullCalls: number
} {
  return {
    externalDepartmentListCalls: counters.departmentListCalls,
    externalDepartmentDetailCalls: counters.departmentDetailCalls,
    externalUserListPageCalls: counters.userListPageCalls,
    externalUserDetailCalls: counters.userDetailCalls,
    externalDirectoryPullCalls:
      counters.departmentListCalls +
      counters.departmentDetailCalls +
      counters.userListPageCalls +
      counters.userDetailCalls,
  }
}
