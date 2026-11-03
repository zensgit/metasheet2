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

/**
 * 抄送未读 — the viewer has not opened this instance since the LATEST CC row that targets them.
 *
 * An `approval_instances` condition (correlated on `${instanceRef}.id`), used verbatim by the
 * unread-CC count (`ApprovalBridgeService.countCcUnreadForViewer`, the count is the 抄送我的 feed
 * with this one conjunct appended) and by the per-row `ccUnread` flag of that feed — so the badge
 * can never exceed the number of rows the tab marks unread.
 *
 * RULE. Unread ⇔ there is no `approval_reads` row for (viewer, instance) whose `read_at` is at or
 * after the newest matching CC row's `occurred_at`. "Has a read row" alone is NOT the rule:
 * `approval_reads` holds ONE row per person per instance, shared with the 待我处理 unread state, so
 * a viewer who opened the instance earlier as its requester or approver — or before a later CC
 * node (or a returned-and-resubmitted flow) CC'd them again — would otherwise have the new CC
 * swallowed silently. The role arm binds the SAME placeholders the tab filter bound, so "which CC
 * rows target me" cannot differ between the list and its badge.
 *
 * KNOWN, ACCEPTED COUPLINGS of sharing that row (no new table, by decision):
 *   - 全部标记已读 (mark-all-read over the viewer's pending seats) also marks read any instance on
 *     which the viewer is BOTH a pending seat holder and a CC target;
 *   - 催办 (remind) deletes the read rows of the instance's current direct assignees, so for a
 *     viewer who is both an assignee and a CC target the CC turns unread again.
 *
 * KNOWN RACE (documented, not closed). `occurred_at` and `read_at` are both column defaults of
 * `now()`, i.e. the START time of their transactions. If the viewer's mark-read commits while the
 * transaction that writes the CC row is still open, `read_at` is later than that CC's
 * `occurred_at` although the viewer could not have seen it, and that CC counts as read. The window
 * is the duration of the advancing transaction; the effect is one missed badge (never a false one),
 * and the row stays visible in 抄送我的. Closing it needs a commit-ordered marker, i.e. DDL.
 */
export function approvalCcUnreadConditionSql(
  placeholders: ApprovalCcTargetPlaceholders & { instanceRef: string },
): string {
  const { instanceRef } = placeholders
  return `NOT EXISTS (
              SELECT 1
              FROM approval_reads cc_read
              WHERE cc_read.instance_id = ${instanceRef}.id
                AND cc_read.user_id = $${placeholders.actorParam}
                AND cc_read.read_at >= (
                  SELECT MAX(cc_rec.occurred_at)
                  FROM approval_records cc_rec
                  WHERE cc_rec.instance_id = ${instanceRef}.id
                    AND cc_rec.action = 'cc'
                    AND ${approvalCcTargetMatchSql(placeholders, 'cc_rec')}
                )
            )`
}
