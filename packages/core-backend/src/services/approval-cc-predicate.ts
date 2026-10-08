/**
 * 抄送我的 (CC) — the ONE builder for "this approval_records row CCs the viewer".
 *
 * The 抄送我的 tab filter and the 已完成 tab's CC arm in `ApprovalBridgeService.listApprovals`
 * used to carry five hand-copied versions of this predicate (one per source mode, plus the CC arm
 * inside each 已完成 filter). They are generated here now, so a count or a per-row read state that
 * is built on the same predicate cannot drift from the list it describes.
 *
 * Shape, unchanged from the hand copies:
 *   - a CC row is `approval_records.action = 'cc'`, written by the graph executor's CC node with
 *     `metadata.targetType` 'user' | 'role' and `metadata.targetId` the user id / role id;
 *   - the user arm matches the viewer's id; the role arm matches the role array bound by the tab
 *     filter (`options.actorRoles`, i.e. `resolveApprovalActorRoles(req)` — the request's role set,
 *     NOT the DB-derived set the list scope binds; see `buildApprovalListScopeCondition`);
 *   - the PLM-source branch of the tab filter has historically matched the USER arm only. That
 *     fork is kept as it was (`rolesParam: null`); PLM mirrors carry no CC rows today, so the two
 *     shapes answer the same rows there.
 *
 * NOT covered here, on purpose: the list SCOPE's CC arm (`buildApprovalListScopeCondition`, arm 4)
 * and the per-instance read predicate (`approval-instance-readability.ts`). Both bind the
 * DB-derived role set and are governed by their own lock; they are separate artifacts, not copies
 * of this one.
 */

export interface ApprovalCcTargetPlaceholders {
  /** Placeholder number bound to the viewer's id. */
  actorParam: number
  /**
   * Placeholder number bound to the viewer's role array, or `null` for the user-only shape the
   * PLM-source 抄送我的 tab has always used.
   */
  rolesParam: number | null
}

/**
 * `(user arm OR role arm)` over one `approval_records` row's `metadata`, optionally qualified by a
 * table alias. The caller supplies `action = 'cc'` (and, in a correlated use, the instance join).
 */
export function approvalCcTargetMatchSql(placeholders: ApprovalCcTargetPlaceholders, recordAlias = ''): string {
  const column = recordAlias ? `${recordAlias}.` : ''
  const userArm = `(${column}metadata->>'targetType' = 'user' AND ${column}metadata->>'targetId' = $${placeholders.actorParam})`
  if (placeholders.rolesParam === null) return userArm
  return `(
                  ${userArm}
                  OR (${column}metadata->>'targetType' = 'role' AND ${column}metadata->>'targetId' = ANY($${placeholders.rolesParam}))
                )`
}

/**
 * The 抄送我的 tab arm as an `approval_instances` condition: the instance has at least one CC row
 * targeting the viewer. Used verbatim by the 抄送我的 filter and as the CC disjunct of 已完成.
 */
export function approvalCcTabConditionSql(placeholders: ApprovalCcTargetPlaceholders): string {
  return `id IN (
              SELECT instance_id
              FROM approval_records
              WHERE action = 'cc'
                AND ${approvalCcTargetMatchSql(placeholders)}
            )`
}
