/**
 * Approval delegation (委托) — resolve-time read seam (READ-ONLY).
 *
 * Reads the `approval_delegations` config table and produces the frozen
 * delegator -> delegatee substitution map for one approval at create time. The
 * map is baked into the instance snapshot (before the executor resolves the
 * initial state) and applied inside `ApprovalAssigneeResolver.pushResolved` — so
 * an in-flight approval never re-routes under a later config edit.
 *
 * Boundary: SELECTs `approval_delegations` only; writes nothing; touches no
 * `approval_*` instance / `automation_*` table. Best-effort — callers swallow
 * failures so a delegation read never blocks approval creation.
 */

type QueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

interface ActiveDelegationRow {
  delegator_user_id: string
  delegatee_user_id: string
}

/**
 * The active delegation map for `templateId` at instant `now`: delegations that are
 * `active`, whose `[start_at, end_at)` window contains `now`, scoped either to all
 * templates or to this template. Returns `delegator -> delegatee`.
 *
 * A delegator may hold at most one active row per scope target (unique index), but
 * can hold one `all` row and one `template` row at once; the **template** scope wins
 * (more specific) via `ORDER BY scope` (`'all'` < `'template'`, so the template row
 * is applied last). Self-delegations cannot exist (table CHECK), so the map has no
 * self-edge.
 */
export async function resolveActiveDelegationMap(
  query: QueryFn,
  options: { templateId: string; now: Date },
): Promise<Record<string, string>> {
  const rows = (
    await query<ActiveDelegationRow>(
      `SELECT delegator_user_id, delegatee_user_id
         FROM approval_delegations
        WHERE active
          AND start_at <= $1 AND end_at > $1
          AND (scope = 'all' OR (scope = 'template' AND scope_template_id = $2))
        ORDER BY scope`,
      [options.now.toISOString(), options.templateId],
    )
  ).rows

  const map: Record<string, string> = {}
  for (const row of rows) {
    const delegator = typeof row.delegator_user_id === 'string' ? row.delegator_user_id.trim() : ''
    const delegatee = typeof row.delegatee_user_id === 'string' ? row.delegatee_user_id.trim() : ''
    if (delegator && delegatee && delegator !== delegatee) {
      map[delegator] = delegatee
    }
  }
  return map
}
