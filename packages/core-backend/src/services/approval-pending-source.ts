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
        href: approvalItemHref(row.id),
        updatedAt: row.updatedAt,
        actionable,
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
