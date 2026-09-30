/**
 * The approval domain's `PendingSource` registration (todo-center-design-lock §3/§3.0/§4) — the
 * ONLY source registered in the v1 first slice.
 *
 * Both `listPendingForUser` and `countPendingForUser` go through the SAME shared query
 * (`approval-pending-query.ts`) `/api/approvals/pending-count` was extracted from, so the todo
 * center's approval numbers can never drift from the badge's (design-lock criterion D). `actionable`
 * on each list item reuses `resolveCanDecideCurrentNode` (`approval-seat-authorization.ts`) — the
 * SAME predicate the decision door enforces — fed by the seat rows the row-version query already
 * brought back in the SAME round trip (no N+1; see that module's docblock).
 */
import { pool } from '../db/pg'
import {
  countApprovalPendingForViewer,
  listApprovalPendingRowsForViewer,
  type ApprovalPendingViewer,
} from './approval-pending-query'
import {
  resolveCanDecideCurrentNode,
  type DecidableInstanceRow,
} from './approval-seat-authorization'
import type { PendingItem, PendingSource, PendingViewer } from './pending-source-registry'
import { APPROVAL_CANCEL_ROUND_WORKFLOW_KEY } from '../attendance/w4c3b-central-approval-hooks'
import type { Pool } from '../db/pg'

export const APPROVAL_PENDING_SOURCE_NAME = 'approval'

function toApprovalPendingViewer(viewer: PendingViewer): ApprovalPendingViewer {
  return {
    actorId: viewer.actorId,
    roles: viewer.roles,
    permissions: viewer.permissions,
  }
}

function approvalItemHref(instanceId: string): string {
  return `/approvals/${instanceId}`
}

/**
 * The attendance workspace's existing deep link to one request (the SAME query shape the approval
 * center opens for an attendance approval: `section` + `requestId`).
 */
const ATTENDANCE_REQUESTS_SECTION = 'attendance-overview-requests'
function attendanceRequestHref(requestId: string): string {
  return `/attendance?section=${ATTENDANCE_REQUESTS_SECTION}&requestId=${encodeURIComponent(requestId)}`
}

/**
 * 撤销锁增补 P-11 (a), landed on the todo-center lock §3 `PendingItem` (RATIFY 追记 2026-09-28,
 * owner 「Adopt all 3, split locks (Recommended)」): a cancel round's todo item links to the ORIGINAL
 * leave — not to the round's own approval detail — so the approver acts in the original document's
 * context. The round → document link is `approval_rounds` (keyed by the round's engine instance); the
 * document → leave link is the attendance request that carries that document as its approval
 * instance. ONE batched read for every cancel-round row of the list (none when the list has no cancel
 * round), never one per row. A round whose document is not an attendance request falls back to the
 * original document's approval detail; a row with no round record keeps the generic link.
 */
async function resolveCancelRoundOriginalHrefs(db: Pool, roundInstanceIds: string[]): Promise<Map<string, string>> {
  const hrefs = new Map<string, string>()
  if (roundInstanceIds.length === 0) return hrefs
  const result = await db.query<{ engine_instance_id: string; document_id: string; request_id: string | null }>(
    `SELECT DISTINCT ON (r.engine_instance_id)
            r.engine_instance_id,
            r.document_id,
            ar.id::text AS request_id
       FROM approval_rounds r
       LEFT JOIN attendance_requests ar ON ar.approval_instance_id = r.document_id
      WHERE r.engine_instance_id = ANY($1::text[])
        AND r.kind = 'cancel'
      ORDER BY r.engine_instance_id, ar.id`,
    [roundInstanceIds],
  )
  for (const row of result.rows) {
    hrefs.set(
      row.engine_instance_id,
      row.request_id ? attendanceRequestHref(row.request_id) : approvalItemHref(row.document_id),
    )
  }
  return hrefs
}

function approvalItemTitle(row: { title: string | null; businessKey: string | null; id: string }): string {
  if (row.title && row.title.trim().length > 0) return row.title
  if (row.businessKey && row.businessKey.trim().length > 0) return row.businessKey
  return row.id
}

/**
 * `null` = every source system (§3.0: the todo center aggregates across `platform`/`plm` the same
 * way the badge's `?sourceSystem=all` does — the center does not expose a source-system filter of
 * its own in this slice).
 */
const AGGREGATE_ALL_SOURCE_SYSTEMS = null

export const approvalPendingSource: PendingSource = {
  name: APPROVAL_PENDING_SOURCE_NAME,

  async listPendingForUser(viewer: PendingViewer): Promise<PendingItem[]> {
    if (!pool) {
      throw new Error('APPROVALS_DATABASE_UNAVAILABLE')
    }
    const rows = await listApprovalPendingRowsForViewer(
      pool,
      toApprovalPendingViewer(viewer),
      AGGREGATE_ALL_SOURCE_SYSTEMS,
    )
    const cancelRoundHrefs = await resolveCancelRoundOriginalHrefs(
      pool,
      rows.filter((row) => row.workflowKey === APPROVAL_CANCEL_ROUND_WORKFLOW_KEY).map((row) => row.id),
    )
    return rows.map((row) => {
      const instance: DecidableInstanceRow = {
        id: row.id,
        status: row.status,
        source_system: row.sourceSystem,
        published_definition_id: row.publishedDefinitionId,
        current_node_key: row.currentNodeKey,
        metadata: row.metadata,
      }
      const actionable = resolveCanDecideCurrentNode({
        instance,
        assignments: row.assignments,
        viewerUserId: viewer.actorId,
        viewerRoles: viewer.roles,
      })
      return {
        source: APPROVAL_PENDING_SOURCE_NAME,
        id: row.id,
        title: approvalItemTitle(row),
        href: cancelRoundHrefs.get(row.id) ?? approvalItemHref(row.id),
        updatedAt: row.updatedAt,
        actionable,
        workflowKey: row.workflowKey,
      }
    })
  },

  async countPendingForUser(viewer: PendingViewer): Promise<number> {
    if (!pool) {
      throw new Error('APPROVALS_DATABASE_UNAVAILABLE')
    }
    const { count } = await countApprovalPendingForViewer(
      pool,
      toApprovalPendingViewer(viewer),
      AGGREGATE_ALL_SOURCE_SYSTEMS,
    )
    return count
  },
}
