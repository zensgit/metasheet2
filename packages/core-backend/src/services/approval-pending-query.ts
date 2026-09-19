/**
 * The ONE shared "pending" query for the approval domain (design-lock v2.14 §3.0, todo-center-design-lock).
 *
 * Extracted verbatim from `routes/approvals.ts`'s `GET /api/approvals/pending-count` (the badge
 * endpoint) so that endpoint, the todo-center approval source, and any future consumer share the
 * SAME WHERE clause rather than each carrying its own copy that can drift (the class of bug the
 * `resolveApprovalActorRoles` / `approval-seat-authorization.ts` extractions already closed for the
 * role-match and seat-match predicates — this closes it for the pending-query predicate itself).
 *
 * Viewer contract is the THREE-INPUT one the lock pins (§3.0): `{ actorId, roles, permissions }`.
 * `roles` MUST be `resolveApprovalActorRoles(req)` — the SAME set the decision door resolves — not
 * the wider DB-rebuilt `viewerRoles` (`approval-instance-readability.ts`); see
 * `approval-seat-authorization.ts`'s own docblock for why the door's narrower set is deliberate.
 *
 * WHERE clause (four conditions, `buildApprovalPendingConditions` below) + the optional
 * `source_system` conjunct are copied byte-for-byte from the pre-extraction route body:
 *   1. `a.is_active = TRUE` — only ACTIVE seats count (a large population: every node advance
 *      deactivates the seats it leaves behind).
 *   2. `i.status = 'pending'` — closed instances never count.
 *   3. The three-arm assignee match (user / role / source_queue) — `assigneeMatchCondition` below,
 *      parameterised by table alias so the row-version query (which re-applies it inside a
 *      correlated subquery) and the count query share the IDENTICAL SQL text rather than two
 *      hand-copies that could diverge (design-lock note: "让 count 与列表的臂集合不一致" is exactly
 *      the drift class this guards against — see the lock's judging criterion C).
 *   4. The handler-node exclusion (`NOT EXISTS ... type = 'handler'`) — a 办理 seat is not an
 *      approval task and must not inflate the pending badge. Polarity: `NOT EXISTS`, so a NULL or
 *      dangling `published_definition_id` is INCLUDED, not excluded — do not "fix" this to
 *      `EXISTS <published definition>`, that flips the polarity the lock's class ⑦ fixture exists to
 *      pin.
 *
 * `source_system` (`sourceSystem` query param upstream) is optional: `'platform'` / `'plm'` add a
 * `COALESCE(i.source_system, 'platform') = $n` conjunct; `'all'` / absent adds nothing.
 *
 * Row-version query (`listApprovalPendingRowsForViewer`): ONE round trip, one row per instance,
 * carrying the SAME instance columns and the viewer's assignment rows
 * `resolveCanDecideCurrentNode` (`approval-seat-authorization.ts`) needs as input — aggregated via a
 * correlated `json_agg` subquery, NOT a second query keyed by instance id (that would be N+1 in
 * spirit even if issued as one `= ANY($ids)` call, and — more importantly — the design-lock requires
 * literally one query). The aggregated seat set is INTENTIONALLY WIDER than the qualifying-instance
 * WHERE: it is the viewer's full set of ACTIVE matching seats on the instance, not filtered by the
 * handler-node exclusion — `resolveCanDecideCurrentNode` needs to see a seat sitting at the CURRENT
 * node even when a DIFFERENT seat on the same instance is what let the row past the handler
 * exclusion (or vice versa). This mirrors `ApprovalBridgeService`'s own `loadAssignments` /
 * `instanceAssignments` shape (full active seat set for the instance), just produced in the SAME
 * query as the instance row instead of a second round trip.
 */
import type { Pool } from '../db/pg'
import type { SeatedAssignment } from './approval-seat-authorization'

export interface ApprovalPendingViewer {
  actorId: string
  roles: string[]
  permissions: string[]
}

export type ApprovalPendingSourceSystemFilter = 'platform' | 'plm' | null

/**
 * The three-arm seat-assignee match, parameterised by the table alias so the count query and the
 * row-version query's correlated subquery use the IDENTICAL text (`$1`/`$2`/`$3` bind the same three
 * params in both call sites — see `buildApprovalPendingConditions` and
 * `listApprovalPendingRowsForViewer`). Do not inline a NEW copy of this string anywhere: that is
 * precisely the drift judging criterion C's mutation looks for.
 *
 * KNOWN EXCEPTION, not created by this module and not yet folded in: `approval-realtime.ts`'s
 * `computeApprovalPendingCounts` (top of that file) hand-copies this same three-arm disjunction but
 * OMITS `handlerNodeExclusionCondition` below — it is a pre-existing, known-divergent second copy
 * relative to the ratified §1.5 ① baseline (todo-center-design-lock v2.14), not an equivalent
 * alternate source of truth. Its presence is not license to add a third. See
 * `docs/development/todo-center-phase1-verification-20260918.md`'s "P1-1" entry for the
 * reproduction (same viewer/instance shape, REST vs. realtime side by side) and the three
 * disposition options (fold in / register + narrow judge D's scope / BLOCKED), still pending an
 * owner call.
 */
export function approvalPendingAssigneeMatchCondition(alias: string): string {
  return `(
    (${alias}.assignment_type = 'user' AND ${alias}.assignee_id = $1)
    OR (${alias}.assignment_type = 'role' AND ${alias}.assignee_id = ANY($2))
    OR (${alias}.assignment_type = 'source_queue' AND ${alias}.assignee_id = ANY($3))
  )`
}

/** Lock-3 §2.2 handler-node exclusion, parameterised by the instance/assignment aliases in scope. */
function handlerNodeExclusionCondition(instanceAlias: string, assignmentAlias: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM approval_published_definitions pd
    WHERE pd.id = ${instanceAlias}.published_definition_id
      AND pd.runtime_graph @> jsonb_build_object('nodes', jsonb_build_array(jsonb_build_object('key', ${assignmentAlias}.node_key, 'type', 'handler')))
  )`
}

interface ApprovalPendingConditions {
  whereSql: string
  params: unknown[]
}

/**
 * The four WHERE conditions (+ optional `source_system` conjunct) over `approval_assignments a
 * INNER JOIN approval_instances i ON i.id = a.instance_id`, exactly as `/pending-count` built them
 * pre-extraction. `params` is always `[actorId, rolesParam, permissionsParam]`, plus `sourceSystem`
 * appended when a filter is requested — same order the original route used.
 */
export function buildApprovalPendingConditions(
  viewer: ApprovalPendingViewer,
  sourceSystem: ApprovalPendingSourceSystemFilter,
): ApprovalPendingConditions {
  const rolesParam = viewer.roles.length > 0 ? viewer.roles : ['__none__']
  const permissionsParam = viewer.permissions.length > 0 ? viewer.permissions : ['__none__']

  const conditions: string[] = [
    `a.is_active = TRUE`,
    `i.status = 'pending'`,
    approvalPendingAssigneeMatchCondition('a'),
    handlerNodeExclusionCondition('i', 'a'),
  ]
  const params: unknown[] = [viewer.actorId, rolesParam, permissionsParam]

  if (sourceSystem) {
    conditions.push(`COALESCE(i.source_system, 'platform') = $${params.length + 1}`)
    params.push(sourceSystem)
  }

  return { whereSql: conditions.join(' AND '), params }
}

export interface ApprovalPendingCountResult {
  count: number
  unreadCount: number
}

/**
 * The badge's own query, byte-for-byte the same SELECT `/pending-count` ran before extraction:
 * `COUNT(DISTINCT a.instance_id)` for `count`, the same aggregate FILTERed on
 * `approval_reads.instance_id IS NULL` (LEFT JOIN keyed on `r.instance_id = a.instance_id AND
 * r.user_id = $1` — BOTH legs matter, see the module docblock in the caller) for `unreadCount`.
 */
export async function countApprovalPendingForViewer(
  pool: Pool,
  viewer: ApprovalPendingViewer,
  sourceSystem: ApprovalPendingSourceSystemFilter,
): Promise<ApprovalPendingCountResult> {
  const { whereSql, params } = buildApprovalPendingConditions(viewer, sourceSystem)

  const result = await pool.query<{ count: string; unread_count: string }>(
    `SELECT COUNT(DISTINCT a.instance_id)::text AS count,
            COUNT(DISTINCT a.instance_id) FILTER (WHERE r.instance_id IS NULL)::text AS unread_count
     FROM approval_assignments a
     INNER JOIN approval_instances i ON i.id = a.instance_id
     LEFT JOIN approval_reads r ON r.instance_id = a.instance_id AND r.user_id = $1
     WHERE ${whereSql}`,
    params,
  )

  return {
    count: parseInt(result.rows[0]?.count || '0', 10),
    unreadCount: parseInt(result.rows[0]?.unread_count || '0', 10),
  }
}

export interface ApprovalPendingRow {
  id: string
  status: string
  sourceSystem: string | null
  publishedDefinitionId: string | null
  currentNodeKey: string | null
  metadata: Record<string, unknown> | null
  title: string | null
  businessKey: string | null
  workflowKey: string | null
  updatedAt: string
  /** The viewer's own ACTIVE matching seats on this instance — see module docblock: wider than the
   *  qualifying-instance WHERE on purpose, so `resolveCanDecideCurrentNode` sees the full seat set. */
  assignments: SeatedAssignment[]
}

interface ApprovalPendingRowRaw {
  id: string
  status: string
  source_system: string | null
  published_definition_id: string | null
  current_node_key: string | null
  metadata: Record<string, unknown> | null
  title: string | null
  business_key: string | null
  workflow_key: string | null
  updated_at: string | Date
  assignments: SeatedAssignment[] | null
}

/**
 * The row-version of the shared query: one row per qualifying instance (same WHERE as
 * `countApprovalPendingForViewer`, so the population is identical — this is what judging criterion
 * C pins), each row carrying the viewer's full active seat set for that instance so a caller can
 * compute `resolveCanDecideCurrentNode` per row WITHOUT a second query per row (no N+1).
 */
export async function listApprovalPendingRowsForViewer(
  pool: Pool,
  viewer: ApprovalPendingViewer,
  sourceSystem: ApprovalPendingSourceSystemFilter,
): Promise<ApprovalPendingRow[]> {
  const { whereSql, params } = buildApprovalPendingConditions(viewer, sourceSystem)
  const seatAggMatch = approvalPendingAssigneeMatchCondition('s')

  const result = await pool.query<ApprovalPendingRowRaw>(
    `WITH matching_instances AS (
       SELECT DISTINCT a.instance_id
       FROM approval_assignments a
       INNER JOIN approval_instances i ON i.id = a.instance_id
       WHERE ${whereSql}
     )
     SELECT
       i.id,
       i.status,
       i.source_system,
       i.published_definition_id,
       i.current_node_key,
       i.metadata,
       i.title,
       i.business_key,
       i.workflow_key,
       i.updated_at,
       COALESCE(
         (
           SELECT json_agg(json_build_object(
             'is_active', s.is_active,
             'assignment_type', s.assignment_type,
             'assignee_id', s.assignee_id,
             'node_key', s.node_key
           ))
           FROM approval_assignments s
           WHERE s.instance_id = i.id
             AND s.is_active = TRUE
             AND ${seatAggMatch}
         ),
         '[]'::json
       ) AS assignments
     FROM matching_instances mi
     INNER JOIN approval_instances i ON i.id = mi.instance_id
     ORDER BY i.updated_at DESC`,
    params,
  )

  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    sourceSystem: row.source_system,
    publishedDefinitionId: row.published_definition_id,
    currentNodeKey: row.current_node_key,
    metadata: row.metadata,
    title: row.title,
    businessKey: row.business_key,
    workflowKey: row.workflow_key,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    assignments: Array.isArray(row.assignments) ? row.assignments : [],
  }))
}
