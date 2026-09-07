/**
 * ApprovalBridgeService
 *
 * Phase 1 bridges PLM approvals into the unified approval backend while
 * keeping PLM as the source of truth.
 */

import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import {
  createPlmApprovalInstanceId,
  toPlatformApprovalBridgeRecord,
  type PlmApprovalBridgeSource,
} from '../federation/plm-approval-bridge'
import type { ApprovalNodeType, FormSchema } from '../types/approval-product'
import { APPROVAL_POLICY_DENIED_ACTION } from '../types/approval-product'
import {
  resolveEffectiveNodeOperations,
  seatNodeKeysForViewer,
  type NodeOperationGraphView,
} from './approval-effective-node-operations'
import { resolveCanDecideCurrentNode } from './approval-seat-authorization'
import type {
  ApprovalActionRequest,
  ApprovalAssignmentRow,
  ApprovalBridgePlmAdapter,
  ApprovalInstanceRow,
  ApprovalQueryOptions,
  PlmSyncOptions,
  UnifiedApprovalDTO,
  UnifiedApprovalHistoryDTO,
} from './approval-bridge-types'
import { APPROVAL_ERROR_CODES } from './approval-bridge-types'
import { isOrgPinEnabled, viewerActiveOrgIds, viewerRolesFailClosed } from './approval-instance-readability'
import {
  collectActiveNodeKeys,
  redactHiddenFormFields,
  resolveFieldAccessAtNodes,
  type RedactableRuntimeGraph,
} from './approval-form-redaction'
import {
  projectRecordLinkFormSnapshotForViewer,
  projectRecordLinkFormSnapshotsForViewerBatch,
} from './approval-record-link-read-projection'
import {
  assertAttendanceCentralMutationFailClosed,
  attendanceCentralApprovalErrorToServiceFields,
} from '../attendance/w4c3b-central-approval-hooks'

/**
 * W4C-3b R0 test-only seam: pause after instance FOR UPDATE + pending check,
 * before attendance fail-closed / terminal DML. Production never sets this.
 */
export type W4c3bBridgeDispatchBarrierPoint = 'after_instance_lock'

type W4c3bBridgeDispatchBarrierFn = (
  point: W4c3bBridgeDispatchBarrierPoint,
  info: { instanceId: string },
) => Promise<void>

let bridgeDispatchTestBarrierForTests: W4c3bBridgeDispatchBarrierFn | null = null

/** Test-only. Pass null to clear. */
export function __setW4c3bBridgeDispatchTestBarrierForTests(
  hook: W4c3bBridgeDispatchBarrierFn | null,
): void {
  bridgeDispatchTestBarrierForTests = hook
}

const logger = new Logger('ApprovalBridgeService')
const PLM_SYNC_CONCURRENCY = 5
const PLM_SYNC_UPSTREAM_PAGE_SIZE = 50
const PLM_SYNC_MAX_WINDOW = 500

type ApprovalRecordRow = {
  id: string | number
  action: string
  actor_id: string | null
  actor_name: string | null
  comment: string | null
  from_status: string | null
  to_status: string
  metadata: Record<string, unknown> | null
  occurred_at: Date | string
}

type PlmApprovalFetch = {
  id: string
  title: string
  status: string
  request_type: string
  version?: number
  product_id?: string
  product_number?: string
  product_name?: string
  requester_id: string
  requester_name: string
  created_at: string
  updated_at?: string
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function toOccurredAt(...values: Array<Date | string | null | undefined>): string | null {
  for (const value of values) {
    const iso = toIsoString(value)
    if (iso) return iso
  }
  return null
}

// Exported (additive-only; no behavior change) so a Lock-10 (S1) test can gate this hand-copied
// detector's agreement with the other two shipped copies + the canonical form in
// approval-instance-readability.ts (OD-S1-18(b): "the divergence of any one of them is a P1").
export function isPlmId(id: string): boolean {
  return id.startsWith('plm:')
}

/**
 * Sentinel pushed in place of an actor id / role set / permission set that the request could not
 * resolve. It is compared against real columns, so it can never match; the scope condition is
 * therefore assembled UNCONDITIONALLY and an unresolvable actor is denied by the predicate itself
 * rather than by a caller remembering to append it. (Appending the conjunct only "when we have an
 * actor" is the same shape as gating a scope on a client-supplied `tab` — the defect this fix
 * removes.)
 *
 * EXPORTED (additive-only; no behaviour change) so the route layer binds the SAME sentinel and a
 * test asserts against the shipped constant instead of a hand-copied string literal.
 */
export const APPROVAL_LIST_SCOPE_NO_MATCH = '__approval_list_scope_no_match__'

/**
 * The list feed's visibility scope, conjoined into EVERY `listApprovals` query — count and page
 * alike — independently of `tab`, `sourceSystem`, or any other client-supplied parameter.
 *
 * ARMS (all OR-ed; the caller conjoins the result with every other filter):
 *   1. REQUESTER    — `requester_snapshot->>'id'`.
 *   2. SEAT         — `approval_assignments`, user- / role- / source_queue-typed, is_active-
 *                     INSENSITIVE (a seat deactivates the moment its holder acts on it; requiring
 *                     `is_active` would drop the row out of 我已处理 / 已完成 for the very person
 *                     who processed it). The role half binds DB-derived roles — see ROLE SOURCE.
 *   3. PAST ACTOR   — any `approval_records` row whose `actor_id` is the viewer.
 *   4. CC TARGET    — `approval_records` `action = 'cc'`, user- or role-typed target; the role half
 *                     binds the same DB-derived role set as arm 2.
 *   5. ADMIN        — the DB-backed approval-admin predicate (`users.is_active` AND
 *                     (`is_admin` OR `role = 'admin'`)), semantically identical to the one
 *                     `approval-instance-readability.ts` uses for its own arm 5 (the SQL text
 *                     differs only in table alias and parameter number). NOT the request's JWT role
 *                     claims: a token-claimed admin does not widen the feed.
 *   6. NON-PLATFORM — rows whose `source_system` is not `platform` keep their phase-1 visibility
 *                     (see the `sourceSystem === 'plm'` branch below, which states that PLM
 *                     assignment filtering does not exist in phase 1 and that the pending PLM queue
 *                     must stay visible). Without this arm the unified inbox would go empty for
 *                     every external mirror, which is an outage, not a narrowing. EMITTED ONLY WHEN
 *                     THE ACTOR RESOLVED: it is the one arm that names no actor column, so leaving
 *                     it in place for an unresolvable actor would make the scope admit every
 *                     external mirror to a caller the request could not identify. With
 *                     `actorResolved` false the predicate is arms 1-5 against the no-match
 *                     sentinel, i.e. it denies everything.
 *
 * ROLE SOURCE (arms 2 and 4). The role array bound here is the DB-derived `viewerRoles()` from
 * `approval-instance-readability.ts` — `users.role` for an active user, unioned with the viewer's
 * `user_roles` rows (both `role_id` and the joined `roles.name`) — the SAME definition the
 * canonical per-instance predicate uses, per OD-S1-17(a) ("roles derived from the DB, never from
 * token claims"). Binding `req.user.role`/`req.user.roles` here instead would let a role claim the
 * DB does not back widen the feed, and would make the feed and the per-instance predicate disagree
 * about what "the viewer's roles" means. `viewerRoles` issues TWO queries (`users`, then
 * `user_roles LEFT JOIN roles`), so every list call that resolves an actor pays two lookups; both
 * callers reach it through `viewerRolesFailClosed`, whose empty-set-on-failure result is bound as
 * the no-match sentinel below, so a lookup failure narrows the role arms instead of 500ing the
 * whole list.
 *
 * PERMISSION SOURCE (arm 2's third disjunct), stated because it is NOT the same as the role source
 * and reading the paragraph above alone would suggest it is. `assignment_type = 'source_queue'`
 * seats are matched against `options.actorPermissions`, which the route fills from the REQUEST's
 * `permissions` / `perms` claims — request-derived, not DB-derived. That asymmetry is pre-existing
 * (the tab filters bind the same array, and this is the column's own storage semantics: a
 * source_queue seat holds a permission string, not a role id) and untouched here. On the production
 * login path the claim itself is DB-derived — `AuthService.resolveRbacProfile` fills `permissions`
 * from `listUserPermissions` and `RBAC_TOKEN_TRUST` is refused there — so the asymmetry is a
 * dev/test-shaped one, but it is real and is named rather than left to be inferred.
 *
 * WHY THIS IS A SECOND ARTIFACT AND NOT A COPY OF `canReadApprovalInstance` (Lock-10 / S1, the ONE
 * per-instance admission predicate). This condition is WIDER than that predicate on exactly two
 * axes, both of which are pre-existing feed behaviour this fix is not authorized to remove:
 *   (a) `assignment_type = 'source_queue'` seats are matched here (against the actor's PERMISSION
 *       set, which is what that column stores) — Lock-10 OD-S1-5 excludes them outright;
 *   (b) non-platform rows are admitted by arm 6 — Lock-10 denies every `plm:` id outright.
 * Folding those two into the canonical predicate would WIDEN detail / history / metrics /
 * attachments, which is an owner decision, not a P0 scope fix. Folding them out of the feed would
 * regress the source-queue pending queue and the unified inbox. `canReadApprovalInstance` remains
 * the SOLE arbiter for detail, history, metrics and attachments, and this function is never
 * consulted there.
 *
 * NOT A "STRICTLY WIDER" CLAIM. An earlier revision of this docblock inferred from (a)/(b) that the
 * scope "can deny no one the canonical predicate admits". That inference is withdrawn: it holds for
 * this condition's own arms only, and the FEED is this condition ANDed with a tab filter, and those
 * tab filters still bind the REQUEST's claim-derived roles (`options.actorRoles`) rather than the DB
 * set. A viewer whose role reaches them only through the DB can therefore still be narrowed by the
 * tab filter on a row the canonical predicate admits. That claim-derived binding in the tab filters
 * is pre-existing and untouched here; only this condition's own arms were moved onto `viewerRoles`.
 *
 * KNOWN CONSEQUENCE, disclosed rather than silently shipped: because this condition is wider on
 * (a)/(b), a row can appear in the feed (source-queue seat, or a non-platform mirror) and still
 * answer 404 when opened. That asymmetry predates this fix — the feed had no scope at all — and
 * closing it means changing one of the two predicates, i.e. an owner ruling. Named for the ledger:
 * this is the Lock-10 G-S1-8 gate (feed ⊆ admission), RECORDED-PENDING per Lock-10 §5.1.1 and cited
 * in `.github/workflows/approval-realdb-instance-readability-s1.yml`'s own header. This change moves
 * the feed TOWARD that containment — it goes from "no scope at all" to "a scope" — but does NOT
 * satisfy it, because the feed stays wider on the two axes (a)/(b) above.
 */
export function buildApprovalListScopeCondition(placeholders: {
  actorParam: number
  rolesParam: number
  permissionsParam: number
  /** FALSE when the request carried no usable actor id. Arms 1-5 are still emitted (so all three
   *  parameters stay referenced and typed — an unreferenced bind is what makes PostgreSQL refuse
   *  the whole statement), but they are compared against the no-match sentinel and arm 6 is left
   *  out, so the predicate denies every row. */
  actorResolved: boolean
}): string {
  const { actorParam, rolesParam, permissionsParam, actorResolved } = placeholders
  const nonPlatformArm = actorResolved
    ? `\n      OR COALESCE(approval_instances.source_system, 'platform') <> 'platform'`
    : ''
  return `(
      approval_instances.requester_snapshot->>'id' = $${actorParam}
      OR EXISTS (
        SELECT 1 FROM approval_assignments scope_seat
         WHERE scope_seat.instance_id = approval_instances.id
           AND (
             (scope_seat.assignment_type = 'user' AND scope_seat.assignee_id = $${actorParam})
             OR (scope_seat.assignment_type = 'role' AND scope_seat.assignee_id = ANY($${rolesParam}::text[]))
             OR (scope_seat.assignment_type = 'source_queue' AND scope_seat.assignee_id = ANY($${permissionsParam}::text[]))
           )
      )
      OR EXISTS (
        SELECT 1 FROM approval_records scope_actor
         WHERE scope_actor.instance_id = approval_instances.id
           AND scope_actor.actor_id = $${actorParam}
      )
      OR EXISTS (
        SELECT 1 FROM approval_records scope_cc
         WHERE scope_cc.instance_id = approval_instances.id
           AND scope_cc.action = 'cc'
           AND (
             (scope_cc.metadata->>'targetType' = 'user' AND scope_cc.metadata->>'targetId' = $${actorParam})
             OR (scope_cc.metadata->>'targetType' = 'role' AND scope_cc.metadata->>'targetId' = ANY($${rolesParam}::text[]))
           )
      )
      OR EXISTS (
        SELECT 1 FROM users scope_admin
         WHERE scope_admin.id = $${actorParam}
           AND scope_admin.is_active = TRUE
           AND (scope_admin.is_admin = TRUE OR scope_admin.role = 'admin')
      )${nonPlatformArm}
    )`
}

function extractExternalId(id: string): string {
  return id.replace(/^plm:/, '')
}

function normalizeSourceVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed
    }
  }

  return null
}

function compareHistoryDescending(
  left: Pick<UnifiedApprovalHistoryDTO, 'occurredAt' | 'id'>,
  right: Pick<UnifiedApprovalHistoryDTO, 'occurredAt' | 'id'>,
): number {
  const leftRawTime = left.occurredAt ? new Date(left.occurredAt).getTime() : Number.NEGATIVE_INFINITY
  const rightRawTime = right.occurredAt ? new Date(right.occurredAt).getTime() : Number.NEGATIVE_INFINITY
  const leftTime = Number.isNaN(leftRawTime) ? Number.NEGATIVE_INFINITY : leftRawTime
  const rightTime = Number.isNaN(rightRawTime) ? Number.NEGATIVE_INFINITY : rightRawTime

  if (leftTime !== rightTime) {
    return rightTime - leftTime
  }

  return String(right.id).localeCompare(String(left.id))
}

function isPlmBridgeUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('HTTP client not initialized')
}

function plmBridgeUnavailableError(): ServiceError {
  return new ServiceError(
    'PLM approval bridge is not configured',
    503,
    'PLM_APPROVAL_BRIDGE_UNAVAILABLE',
  )
}

// Lock-3 §2.2 — the current node's TYPE from the frozen runtime graph (structural JSONB read; no
// re-validation). `null` when there is no graph or no cursor, or the node/type is malformed.
function resolveCurrentNodeType(
  runtimeGraph: RedactableRuntimeGraph | null,
  currentNodeKey: string | null,
): ApprovalNodeType | null {
  if (!runtimeGraph?.nodes || !currentNodeKey) return null
  for (const node of runtimeGraph.nodes) {
    if (node && node.key === currentNodeKey && typeof node.type === 'string') {
      return node.type as ApprovalNodeType
    }
  }
  return null
}

function toUnifiedDTO(
  row: ApprovalInstanceRow,
  assignments: ApprovalAssignmentRow[] = [],
  runtimeGraph: RedactableRuntimeGraph | null = null,
): UnifiedApprovalDTO {
  // P1-C: redact form fields the instance's currently-active node(s) mark
  // `hidden`. Keyed on the instance-active node, NOT the viewer — so observers /
  // admins / the requester are all redacted alike. `runtimeGraph` is null for
  // bridged/external instances (no node config) → snapshot unchanged.
  const formSnapshot = redactHiddenFormFields(
    row.form_snapshot || null,
    runtimeGraph,
    collectActiveNodeKeys(row.current_node_key, row.metadata),
  )
  // Lock-3 §2.2 — resolve the current node's TYPE from the frozen runtime graph so the member 待办
  // surface can withhold approve/reject on a 办理 (handler) task. Structural read of the same JSONB
  // view already loaded for redaction; null when there is no graph (bridged/external) or no cursor.
  const currentNodeType = resolveCurrentNodeType(runtimeGraph, row.current_node_key)
  return {
    id: row.id,
    sourceSystem: row.source_system,
    externalApprovalId: row.external_approval_id,
    workflowKey: row.workflow_key,
    businessKey: row.business_key,
    title: row.title,
    status: row.status,
    requester: row.requester_snapshot || null,
    subject: row.subject_snapshot || null,
    policy: row.policy_snapshot || null,
    currentStep: row.current_step,
    totalSteps: row.total_steps,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    publishedDefinitionId: row.published_definition_id,
    requestNo: row.request_no,
    formSnapshot,
    currentNodeKey: row.current_node_key,
    ...(currentNodeType ? { currentNodeType } : {}),
    assignments: assignments.map((assignment) => ({
      id: assignment.id,
      type: assignment.assignment_type,
      assigneeId: assignment.assignee_id,
      sourceStep: assignment.source_step,
      nodeKey: assignment.node_key,
      isActive: assignment.is_active,
      metadata: assignment.metadata || {},
    })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toBridgeSource(raw: {
  id: string
  title: string
  status: string
  request_type: string
  version?: number
  product_id?: string
  product_number?: string
  product_name?: string
  requester_id: string
  requester_name: string
  created_at: string
  updated_at?: string
}): PlmApprovalBridgeSource {
  return {
    id: raw.id,
    title: raw.title,
    status: raw.status,
    type: raw.request_type,
    product_id: raw.product_id,
    product_number: raw.product_number,
    product_name: raw.product_name,
    requester_id: raw.requester_id,
    requester_name: raw.requester_name,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    version: raw.version,
  }
}

export class ApprovalBridgeService {
  constructor(private readonly plmAdapter: ApprovalBridgePlmAdapter | null = null) {}

  hasPlmAdapter(): boolean {
    return this.plmAdapter !== null
  }

  async syncPlmApprovals(options?: PlmSyncOptions): Promise<{
    synced: number
    errors: Array<{ externalId: string; error: string }>
  }> {
    if (!pool) throw new Error('Database not available')

    const approvals = await this.fetchPlmApprovalWindow(options)

    let synced = 0
    const errors: Array<{ externalId: string; error: string }> = []

    const syncResults = await this.runInBatches(approvals, PLM_SYNC_CONCURRENCY, async (approval) => {
      await this.upsertPlmMirror(toBridgeSource(approval))
      return approval.id
    })

    syncResults.forEach((settledResult, index) => {
      if (settledResult.status === 'fulfilled') {
        synced += 1
      } else {
        const approval = approvals[index]
        errors.push({
          externalId: String(approval.id),
          error: settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason),
        })
      }
    })

    return { synced, errors }
  }

  async listApprovals(options?: ApprovalQueryOptions): Promise<{
    data: UnifiedApprovalDTO[]
    total: number
  }> {
    if (!pool) throw new Error('Database not available')

    const conditions: string[] = []
    const params: unknown[] = []
    let paramIndex = 1

    if (options?.sourceSystem) {
      conditions.push(`source_system = $${paramIndex++}`)
      params.push(options.sourceSystem)
    }
    if (options?.status) {
      conditions.push(`status = $${paramIndex++}`)
      params.push(options.status)
    }
    if (options?.workflowKey) {
      conditions.push(`workflow_key = $${paramIndex++}`)
      params.push(options.workflowKey)
    }
    if (options?.businessKey) {
      conditions.push(`business_key = $${paramIndex++}`)
      params.push(options.businessKey)
    }
    if (options?.assignee) {
      conditions.push(
        `id IN (
          SELECT instance_id
          FROM approval_assignments
          WHERE assignee_id = $${paramIndex++}
            AND is_active = TRUE
        )`,
      )
      params.push(options.assignee)
    }
    if (options?.search) {
      conditions.push(`(COALESCE(request_no, '') ILIKE $${paramIndex} OR COALESCE(title, '') ILIKE $${paramIndex})`)
      params.push(`%${options.search}%`)
      paramIndex += 1
    }
    // B3-03 (模板/时间筛选): template + created-at window. Additive filters that compose with every
    // other filter (including tab) below — each pushed only when supplied, so the legacy feed is
    // unchanged when none are provided.
    if (options?.templateId) {
      conditions.push(`template_id = $${paramIndex++}`)
      params.push(options.templateId)
    }
    if (options?.createdFrom) {
      conditions.push(`created_at >= $${paramIndex++}`)
      params.push(options.createdFrom)
    }
    if (options?.createdTo) {
      conditions.push(`created_at <= $${paramIndex++}`)
      params.push(options.createdTo)
    }
    const sourceSystem = options?.sourceSystem
    const includeExternalTabSources = options?.includeExternalTabSources === true
    if (options?.tab && options.actorId) {
      const actorRoles = options.actorRoles && options.actorRoles.length > 0 ? options.actorRoles : ['__none__']
      const actorPermissions = options.actorPermissions && options.actorPermissions.length > 0 ? options.actorPermissions : ['__none__']
      const tabActorId = options.actorId

      // PLACEHOLDERS ARE ALLOCATED ON FIRST REFERENCE, never ahead of the branch that uses them.
      // The two branches below used to bind the actor id, the role array and the permission array
      // eagerly for every tab, but `mine` references only the actor id, `cc` never references the
      // permission array and `processed` references neither array — so the statement bound values
      // its own text declared no placeholder for. PostgreSQL refuses that: at the Bind step while
      // the trailing parameters were the unreferenced ones ("bind message supplies N parameters,
      // but prepared statement \"\" requires M"), and at the Parse step once later conjuncts
      // referenced higher placeholders and left the unreferenced ones as untyped holes in the
      // middle ("could not determine data type of parameter $N"). Either way 我发起的 / 抄送我的 /
      // 我已处理 answered 500 on real PostgreSQL. Allocating on first reference keeps every bound
      // value referenced and the numbering dense, for all five tabs in both source modes.
      let tabActorIdParam: number | null = null
      let tabActorRolesParam: number | null = null
      let tabActorPermissionsParam: number | null = null
      const actorIdParam = (): number => {
        if (tabActorIdParam === null) {
          tabActorIdParam = paramIndex++
          params.push(tabActorId)
        }
        return tabActorIdParam
      }
      const actorRolesParam = (): number => {
        if (tabActorRolesParam === null) {
          tabActorRolesParam = paramIndex++
          params.push(actorRoles)
        }
        return tabActorRolesParam
      }
      const actorPermissionsParam = (): number => {
        if (tabActorPermissionsParam === null) {
          tabActorPermissionsParam = paramIndex++
          params.push(actorPermissions)
        }
        return tabActorPermissionsParam
      }

      if (sourceSystem === 'plm') {
        // PLM assignment filtering is not available in phase 1. The source
        // filter should still make the pending PLM queue visible instead of
        // combining `source_system = 'plm'` with platform-only assignment rules.
        if (options.tab === 'pending') {
          conditions.push(`status = 'pending'`)
        } else if (options.tab === 'mine') {
          conditions.push(`requester_snapshot->>'id' = $${actorIdParam()}`)
        } else if (options.tab === 'cc') {
          conditions.push(
            `id IN (
              SELECT instance_id
              FROM approval_records
              WHERE action = 'cc'
                AND metadata->>'targetType' = 'user'
                AND metadata->>'targetId' = $${actorIdParam()}
            )`,
          )
        } else if (options.tab === 'completed') {
          conditions.push(`status <> 'pending'`)
        } else if (options.tab === 'processed') {
          // B3-01 (我已处理): every instance the actor recorded an action on, ANY current status.
          conditions.push(
            `id IN (
              SELECT instance_id
              FROM approval_records
              WHERE actor_id = $${actorIdParam()}
            )`,
          )
        }
      } else if (includeExternalTabSources) {
        if (options.tab === 'pending') {
          conditions.push(
            `(
              (
                COALESCE(source_system, 'platform') = 'platform'
                AND status = 'pending'
                AND id IN (
                  SELECT instance_id
                  FROM approval_assignments
                  WHERE is_active = TRUE
                    AND (
                      (assignment_type = 'user' AND assignee_id = $${actorIdParam()})
                      OR (assignment_type = 'role' AND assignee_id = ANY($${actorRolesParam()}))
                      OR (assignment_type = 'source_queue' AND assignee_id = ANY($${actorPermissionsParam()}))
                    )
                )
              )
              OR (
                COALESCE(source_system, 'platform') <> 'platform'
                AND status = 'pending'
              )
            )`,
          )
        } else if (options.tab === 'mine') {
          conditions.push(`requester_snapshot->>'id' = $${actorIdParam()}`)
        } else if (options.tab === 'cc') {
          conditions.push(
            `id IN (
              SELECT instance_id
              FROM approval_records
              WHERE action = 'cc'
                AND (
                  (metadata->>'targetType' = 'user' AND metadata->>'targetId' = $${actorIdParam()})
                  OR (metadata->>'targetType' = 'role' AND metadata->>'targetId' = ANY($${actorRolesParam()}))
                )
            )`,
          )
        } else if (options.tab === 'completed') {
          conditions.push(
            `(
              (
                COALESCE(source_system, 'platform') = 'platform'
                AND status <> 'pending'
                AND (
                  requester_snapshot->>'id' = $${actorIdParam()}
                  OR id IN (
                    SELECT instance_id FROM approval_records WHERE actor_id = $${actorIdParam()}
                  )
                  OR id IN (
                    SELECT instance_id
                    FROM approval_records
                    WHERE action = 'cc'
                      AND (
                        (metadata->>'targetType' = 'user' AND metadata->>'targetId' = $${actorIdParam()})
                        OR (metadata->>'targetType' = 'role' AND metadata->>'targetId' = ANY($${actorRolesParam()}))
                      )
                  )
                  OR id IN (
                    SELECT instance_id
                    FROM approval_assignments
                    WHERE (assignment_type = 'user' AND assignee_id = $${actorIdParam()})
                       OR (assignment_type = 'role' AND assignee_id = ANY($${actorRolesParam()}))
                       OR (assignment_type = 'source_queue' AND assignee_id = ANY($${actorPermissionsParam()}))
                  )
                )
              )
              OR (
                COALESCE(source_system, 'platform') <> 'platform'
                AND status <> 'pending'
              )
            )`,
          )
        } else if (options.tab === 'processed') {
          // B3-01 (我已处理): actor-recorded instances, ANY status/source. approval_records is
          // platform-side only, so this naturally scopes to platform rows the actor acted on —
          // consistent with `completed`'s own `approval_records` OR-arm above, minus the
          // `status <> 'pending'` restriction (processed is NOT limited by current status).
          conditions.push(
            `id IN (
              SELECT instance_id
              FROM approval_records
              WHERE actor_id = $${actorIdParam()}
            )`,
          )
        }
      } else {
        // SOURCE CONJUNCT, and the one case that must NOT get it. This branch's own
        // `COALESCE(source_system, 'platform') = 'platform'` is the legacy rule "an explicitly
        // supplied tab implies the platform feed". A request that supplied NO tab is served the
        // default tab (`tabDefaulted`), and applying the legacy rule to it would flip the tab-less,
        // sourceSystem-less feed from the merge-base's MIXED platform+plm shape to platform-only —
        // a source-filter change smuggled in by a tab default. `sourceSystem`'s own semantics are
        // untouched either way: an explicit `platform` still pushes `source_system = $n` above, and
        // an explicit `all` still routes to the `includeExternalTabSources` branch.
        if (!options.tabDefaulted) {
          conditions.push(`COALESCE(source_system, 'platform') = 'platform'`)
        }

        if (options.tab === 'pending') {
          conditions.push(`status = 'pending'`)
          conditions.push(
            `id IN (
              SELECT instance_id
              FROM approval_assignments
              WHERE is_active = TRUE
                AND (
                  (assignment_type = 'user' AND assignee_id = $${actorIdParam()})
                  OR (assignment_type = 'role' AND assignee_id = ANY($${actorRolesParam()}))
                  OR (assignment_type = 'source_queue' AND assignee_id = ANY($${actorPermissionsParam()}))
                )
            )`,
          )
        } else if (options.tab === 'mine') {
          conditions.push(`requester_snapshot->>'id' = $${actorIdParam()}`)
        } else if (options.tab === 'cc') {
          conditions.push(
            `id IN (
              SELECT instance_id
              FROM approval_records
              WHERE action = 'cc'
                AND (
                  (metadata->>'targetType' = 'user' AND metadata->>'targetId' = $${actorIdParam()})
                  OR (metadata->>'targetType' = 'role' AND metadata->>'targetId' = ANY($${actorRolesParam()}))
                )
            )`,
          )
        } else if (options.tab === 'completed') {
          conditions.push(`status <> 'pending'`)
          conditions.push(
            `(
              requester_snapshot->>'id' = $${actorIdParam()}
              OR id IN (
                SELECT instance_id FROM approval_records WHERE actor_id = $${actorIdParam()}
              )
              OR id IN (
                SELECT instance_id
                FROM approval_records
                WHERE action = 'cc'
                  AND (
                    (metadata->>'targetType' = 'user' AND metadata->>'targetId' = $${actorIdParam()})
                    OR (metadata->>'targetType' = 'role' AND metadata->>'targetId' = ANY($${actorRolesParam()}))
                  )
              )
              OR id IN (
                SELECT instance_id
                FROM approval_assignments
                WHERE (assignment_type = 'user' AND assignee_id = $${actorIdParam()})
                   OR (assignment_type = 'role' AND assignee_id = ANY($${actorRolesParam()}))
                   OR (assignment_type = 'source_queue' AND assignee_id = ANY($${actorPermissionsParam()}))
              )
            )`,
          )
        } else if (options.tab === 'processed') {
          // B3-01 (我已处理): platform instances the actor recorded ANY action on, ANY status — the
          // `COALESCE(source_system, 'platform') = 'platform'` guard above already scopes source.
          conditions.push(
            `id IN (
              SELECT instance_id
              FROM approval_records
              WHERE actor_id = $${actorIdParam()}
            )`,
          )
        }
      }
    }

    // ── Server-determined visibility scope ────────────────────────────────────────────────────
    // Appended LAST and UNCONDITIONALLY. Every branch above is a client-driven FILTER (`tab`,
    // `sourceSystem`, `status`, `assignee`, `search`, `templateId`, the created-at window); this
    // conjunct is the SCOPE, and no request parameter — present, absent, or unrecognised — can
    // reach the query without it. It is pushed after every other parameter so the existing
    // filters' placeholder numbering is untouched.
    const scopeActorId = typeof options?.actorId === 'string' && options.actorId.trim().length > 0
      ? options.actorId
      : null
    // ROLES ARE READ FROM THE DB, not from `options.actorRoles` (which the route fills from the
    // request's own `role` / `roles` claims). `viewerRoles` is the canonical definition
    // `canReadApprovalInstance` uses for its own role-typed arms — OD-S1-17(a), "roles derived from
    // the DB, never from token claims" — so the two predicates now agree on what "the viewer's
    // roles" means, and a role a token asserts but the DB does not back cannot widen the feed.
    // (`options.actorRoles` is still what the TAB filters bind; moving those is a separate change
    // with its own blast radius, and is called out in this module's scope docblock.)
    //
    // COST, stated exactly rather than approximately: `viewerRoles` issues TWO queries — one on
    // `users` and one on `user_roles LEFT JOIN roles` — so a list call that resolves an actor pays
    // TWO extra lookups, and this surface now depends on two tables (`user_roles`, `roles`) the
    // list queries did not previously read. FAIL CLOSED via `viewerRolesFailClosed`: a failure of
    // either lookup yields an EMPTY role set, which is bound below as the no-match sentinel, so the
    // role-typed seat and CC arms match nothing and the caller still gets their requester /
    // user-seat / past-actor / admin rows — instead of the whole list answering 500. It can only
    // ever remove rows from a response, never add one. (`viewerActiveOrgIds` in the org-pin block
    // below is NOT wrapped: it is reached only while the dormant pin flag is on, so its failure
    // path is unreachable on the shipped default and adding an untested branch there would be a
    // behaviour change with no gate. Disclosed rather than silently differing.)
    const scopeRoles = scopeActorId ? await viewerRolesFailClosed(pool, scopeActorId) : []
    const scopeRolesParamValue = scopeRoles.length > 0 ? scopeRoles : [APPROVAL_LIST_SCOPE_NO_MATCH]
    const scopePermissions = scopeActorId && options?.actorPermissions && options.actorPermissions.length > 0
      ? options.actorPermissions
      : [APPROVAL_LIST_SCOPE_NO_MATCH]
    const scopeActorParam = paramIndex++
    params.push(scopeActorId ?? APPROVAL_LIST_SCOPE_NO_MATCH)
    const scopeRolesParam = paramIndex++
    params.push(scopeRolesParamValue)
    const scopePermissionsParam = paramIndex++
    params.push(scopePermissions)
    conditions.push(buildApprovalListScopeCondition({
      actorParam: scopeActorParam,
      rolesParam: scopeRolesParam,
      permissionsParam: scopePermissionsParam,
      actorResolved: scopeActorId !== null,
    }))

    // ORG PIN — the SAME `APPROVAL_S1_ORG_PIN_ENABLED` gate `canReadApprovalInstance` reads, and
    // the same `viewerActiveOrgIds` definition of "the viewer's orgs". Enforcing the org column
    // here while the per-instance predicate leaves it dormant would make the pin mean two
    // different things (Lock-10: the divergence of any one of these is a P1), and would black out
    // every row whose `org_id` is still NULL — an outage, not a narrowing. Activation is the
    // flag's own owner-gated step, not this fix's to take. As in the canonical predicate, the
    // column is named in the SQL text ONLY when the pin is on, so a missing/renamed column cannot
    // deny every request while the pin is off.
    //
    // THE PIN GOVERNS PLATFORM ROWS ONLY. `canReadApprovalInstance` refuses a `plm:` id at
    // `approval-instance-readability.ts`'s `if (isPlmApprovalId(instanceId)) return false` (its
    // OD-S1-18 guard), which runs BEFORE `pinEnabled` is even consulted and before the org clause
    // is assembled — so in the canonical predicate the org pin has, by construction, no say over a
    // non-platform row. Mirroring that here means the org conjunct applies to platform rows and
    // leaves arm 6's non-platform rows alone. It matters: `approval_instances.org_id` is NULL for
    // `plm:` mirrors BY DESIGN (migration `zzzz20260821100000` — "Class 5 (`plm:` mirrors) …
    // `org_id` stays NULL there permanently"), so an unqualified org conjunct would empty the
    // unified inbox of every external mirror the moment the pin is switched on, and no backfill
    // would ever fix it. The alternative shape — exempting every row whose `org_id` is NULL —
    // is REJECTED: that would also exempt platform rows awaiting Migration B's backfill, and
    // OD-S1-9(e) rules a NULL `org_id` false for everyone, admin included.
    if (isOrgPinEnabled()) {
      const scopeOrgIds = scopeActorId ? await viewerActiveOrgIds(pool, scopeActorId) : []
      const scopeOrgParam = paramIndex++
      params.push(scopeOrgIds.length > 0 ? scopeOrgIds : [APPROVAL_LIST_SCOPE_NO_MATCH])
      conditions.push(
        `(
          COALESCE(approval_instances.source_system, 'platform') <> 'platform'
          OR approval_instances.org_id = ANY($${scopeOrgParam}::text[])
        )`,
      )
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM approval_instances ${whereClause}`,
      params,
    )
    const total = parseInt(countResult.rows[0]?.count || '0', 10)

    const instancesResult = await pool.query<ApprovalInstanceRow>(
      `SELECT * FROM approval_instances ${whereClause}
       ORDER BY COALESCE(source_updated_at, updated_at) DESC, updated_at DESC, id DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    )

    const assignmentsByInstance = await this.loadAssignments(instancesResult.rows.map((row) => row.id))
    const runtimeGraphsByDefinition = await this.loadRuntimeGraphs(
      instancesResult.rows.map((row) => row.published_definition_id),
    )

    // B3-02 (行级未读): resolve `isRead` ONLY for the 待我处理 (pending) tab — the single surface
    // the unread badge/dot semantics cover. A row is UNREAD (isRead=false) exactly when the actor
    // has NO `approval_reads` row for it — byte-identical to the pending-count badge's own
    // `FILTER (WHERE r.instance_id IS NULL)` predicate (see /api/approvals/pending-count above).
    // A single id-scoped lookup gives the same result as folding a LEFT JOIN into the paginated
    // list query, without widening that query's shape. Left `null` (→ DTO field omitted) on every
    // other tab, so no dot is ever rendered there.
    let readInstanceIds: Set<string> | null = null
    if (options?.tab === 'pending' && options.actorId && instancesResult.rows.length > 0) {
      const readResult = await pool.query<{ instance_id: string }>(
        `SELECT instance_id
         FROM approval_reads
         WHERE user_id = $1
           AND instance_id = ANY($2::text[])`,
        [options.actorId, instancesResult.rows.map((row) => row.id)],
      )
      readInstanceIds = new Set(readResult.rows.map((row) => row.instance_id))
    }

    const data = instancesResult.rows.map((row) => {
      const dto = toUnifiedDTO(
        row,
        assignmentsByInstance.get(row.id) || [],
        row.published_definition_id ? runtimeGraphsByDefinition.get(row.published_definition_id) ?? null : null,
      )
      if (readInstanceIds) {
        dto.isRead = readInstanceIds.has(row.id)
      }
      return dto
    })

    // FWB-0 Layer 2 P1-1: project record-link fields for the list viewer (actorId).
    // Fail-closed redaction when actorId is absent; authorized viewers keep { recordId }.
    if (data.length > 0) {
      const queryFn = (sql: string, params?: unknown[]) => pool!.query(sql, params)
      const projected = await projectRecordLinkFormSnapshotsForViewerBatch(
        data.map((dto, index) => ({
          formSnapshot: dto.formSnapshot ?? null,
          templateVersionId: instancesResult.rows[index]?.template_version_id ?? null,
        })),
        options?.actorId ?? null,
        queryFn,
      )
      for (let i = 0; i < data.length; i += 1) {
        data[i]!.formSnapshot = projected[i] ?? null
      }
    }

    return {
      data,
      total,
    }
  }

  /**
   * `viewerRoles` (Lock-5 §2.3 / gate A-2, adversarial-gate finding P2-1 on PR #4983): the viewer's
   * ROLE ids. Required — not optional-in-spirit — because an approval seat may be ROLE-typed, and
   * the dispatch choke treats such a seat as first-class (`assignmentMatchesActor` matches when the
   * actor's roles contain the assignment's `assignee_id`). A carrier scoped to user-typed seats only
   * left every role-seated approver with NO `nodeOperations`, so the member bar rendered all four
   * verbs and the server 409'd each click. Callers that genuinely have no role context pass nothing
   * and get the pre-existing user-only scoping.
   */
  async getApproval(
    id: string,
    viewerUserId?: string | null,
    viewerRoles?: readonly string[] | null,
  ): Promise<UnifiedApprovalDTO | null> {
    if (!pool) throw new Error('Database not available')

    if (isPlmId(id)) {
      try {
        await this.refreshPlmInstance(id)
      } catch (error) {
        logger.warn(
          `PLM approval refresh failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
        )
        await this.markSyncError(id, error)
      }
    }

    const row = await this.loadApprovalInstance(id)
    if (!row) return null

    const assignmentsByInstance = await this.loadAssignments([id])
    const runtimeGraphsByDefinition = await this.loadRuntimeGraphs([row.published_definition_id])
    const instanceAssignments = assignmentsByInstance.get(id) || []
    const detailRuntimeGraph = row.published_definition_id ? runtimeGraphsByDefinition.get(row.published_definition_id) ?? null : null
    const dto = toUnifiedDTO(
      row,
      instanceAssignments,
      detailRuntimeGraph,
    )
    // Lock-7 OD-L7-10 — DETAIL-only actor-scoped per-field access map. Computed from the viewer's
    // ACTIVE user-typed seats (the same seats the write path claims), over the SAME
    // `resolveFieldAccessAtNodes` derivation as the write mask, so `editable` here ⊆ writable there
    // (never over-reported). A seatless / role-only / queue-only viewer gets no map (fail-closed —
    // nothing editable). Multi-seat is most-restrictive-wins. NOT added to `toUnifiedDTO` (kept
    // byte-identical for the list path, which shares that function). Absent ≡ editable (OD-L7-9).
    if (dto && viewerUserId && detailRuntimeGraph) {
      const actorNodeKeys = instanceAssignments
        .filter((assignment) => assignment.is_active && assignment.assignment_type === 'user' && assignment.assignee_id === viewerUserId)
        .map((assignment) => assignment.node_key)
        .filter((nodeKey): nodeKey is string => typeof nodeKey === 'string' && nodeKey.length > 0)
      if (actorNodeKeys.length > 0) {
        const accessMap = resolveFieldAccessAtNodes(detailRuntimeGraph, actorNodeKeys)
        if (accessMap.size > 0) dto.fieldAccess = Object.fromEntries(accessMap)
      }
    }
    // Lock-5 §2.3 / gate A-2 — the ACTOR-SCOPED effective operation policy, resolved from the SAME
    // frozen graph the dispatch choke reads and shipped as DECIDED booleans so the client renders
    // rather than re-derives. Scoped exactly like `fieldAccess` above:
    //   * the viewer's OWN ACTIVE user-typed seats, NOT `row.current_node_key`. Inside a parallel
    //     region the cursor is the fork GATEWAY while the choke resolves policy from the actor's own
    //     assignment `node_key` — deriving from the cursor would mirror the wrong node's policy on
    //     every parallel instance (the divergence class §2.3 forbids compounding);
    //   * BOTH user-typed and ROLE-typed seats. A role seat is first-class at the choke
    //     (`assignmentMatchesActor` matches when the actor's roles contain the assignment's
    //     `assignee_id`), so scoping the mirror to user seats made it silently absent for every
    //     role-seated approver — who DOES have a bar, because FE `canAct` is global RBAC
    //     `approvals:act`, not an assignment check. The earlier comment here claimed such a viewer
    //     "has no member-action bar to gate"; that was FALSE and is corrected (gate finding P2-1);
    //   * a viewer holding NO seat of either kind still gets nothing — correct, and the reason the
    //     `null` return of `resolveEffectiveNodeOperations` is kept;
    //   * multi-seat is most-restrictive, so the client can never over-report a capability the
    //     server would then refuse.
    if (dto && viewerUserId && detailRuntimeGraph) {
      // ONE shared predicate (`seatNodeKeysForViewer`), not a hand-copy: it mirrors the choke's
      // `assignmentMatchesActor` exactly, including refusing a `'source_queue'` seat outright.
      const seatNodeKeys = seatNodeKeysForViewer(instanceAssignments, viewerUserId, viewerRoles)
      const nodeOperations = resolveEffectiveNodeOperations(
        detailRuntimeGraph as NodeOperationGraphView,
        seatNodeKeys,
        row.policy_snapshot,
      )
      if (nodeOperations) dto.nodeOperations = nodeOperations
    }
    // Viewer-scoped decision affordance. The detail view renders approve/reject and the member
    // verbs on the coarse `approvals:act` grant alone, which disagrees with the server for anyone
    // who may act somewhere but not at the node this instance is stopped on. This is the server's
    // own answer for THIS viewer, produced by the door's OWN predicate
    // (`assignmentMatchesActor` over `decidableNodeKeysForInstance`) rather than a second
    // approximation — see `approval-seat-authorization.ts`. `viewerRoles` is the same set the
    // route hands the dispatch door (`resolveApprovalActorRoles`), so a ROLE-typed seat is
    // first-class here exactly as it is there.
    if (dto) {
      dto.canDecideCurrentNode = resolveCanDecideCurrentNode({
        instance: row,
        assignments: instanceAssignments,
        viewerUserId: viewerUserId ?? null,
        viewerRoles: viewerRoles ?? null,
      })
    }
    // Attach the FROZEN form schema (detail `columns` included) from the instance's pinned
    // template version so the read renders detail rows from the frozen schema (design-lock Fact B).
    if (dto && row.template_version_id) {
      const versionResult = await pool.query<{ form_schema: Record<string, unknown> }>(
        `SELECT form_schema FROM approval_template_versions WHERE id = $1`,
        [row.template_version_id],
      )
      const frozen = versionResult.rows[0]?.form_schema
      if (frozen) dto.formSchema = frozen as unknown as FormSchema
    }
    // FWB-0 Layer 2 P1-1: redact stored linked record ids unless the viewer has fresh target authz.
    if (dto?.formSnapshot) {
      const queryFn = (sql: string, params?: unknown[]) => pool!.query(sql, params)
      dto.formSnapshot = await projectRecordLinkFormSnapshotForViewer(
        dto.formSnapshot,
        dto.formSchema ?? null,
        viewerUserId,
        queryFn,
      )
    }
    return dto
  }

  async getApprovalHistory(id: string): Promise<UnifiedApprovalHistoryDTO[]> {
    if (isPlmId(id)) {
      return this.getPlmHistory(id)
    }

    return this.loadLocalHistory(id)
  }

  async dispatchAction(
    id: string,
    request: ApprovalActionRequest,
    actor: { userId: string; userName?: string; ip?: string | null; userAgent?: string | null },
  ): Promise<UnifiedApprovalDTO> {
    if (!pool) throw new Error('Database not available')

    if (isPlmId(id)) {
      try {
        await this.refreshPlmInstance(id)
      } catch (error) {
        logger.warn(
          `PLM approval refresh before action failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
        )
        await this.markSyncError(id, error)
      }
    }
    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const lockedResult = await client.query<ApprovalInstanceRow>(
        `SELECT * FROM approval_instances
         WHERE id = $1
         FOR UPDATE`,
        [id],
      )
      const instance = lockedResult.rows[0]
      if (!instance) {
        throw new ServiceError('Approval not found', 404, APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND)
      }

      if (instance.status !== 'pending') {
        throw new ServiceError(
          `Cannot ${request.action}: current status is ${instance.status}`,
          409,
          APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION,
        )
      }

      if (bridgeDispatchTestBarrierForTests) {
        await bridgeDispatchTestBarrierForTests('after_instance_lock', { instanceId: id })
      }

      // P17/P22: attendance instances cannot terminalize through the generic bridge.
      // Classify + lock request before any instance/assignment DML (including
      // adversarial published_definition_id rows).
      try {
        await assertAttendanceCentralMutationFailClosed(client, instance)
      } catch (error) {
        const fields = attendanceCentralApprovalErrorToServiceFields(error)
        if (fields) {
          throw new ServiceError(fields.message, fields.statusCode, fields.code)
        }
        throw error
      }

      const rejectCommentRequired = instance.policy_snapshot?.rejectCommentRequired !== false
      if (request.action === 'reject' && rejectCommentRequired && !request.comment?.trim()) {
        throw new ServiceError(
          'Rejection comment is required',
          400,
          APPROVAL_ERROR_CODES.REJECT_COMMENT_REQUIRED,
        )
      }

      if (instance.source_system === 'plm') {
        await this.dispatchPlmAction(id, this.resolvePlmSourceVersion(instance), request)
      }

      const nextStatus = request.action === 'approve' ? 'approved' : 'rejected'
      const nextVersion = instance.version + 1

      const updateResult = await client.query(
        `UPDATE approval_instances
         SET status = $1,
             version = $2,
             sync_status = 'ok',
             sync_error = NULL,
             last_synced_at = now(),
             updated_at = now()
         WHERE id = $3
           AND version = $4
           AND status = $5`,
        [nextStatus, nextVersion, id, instance.version, instance.status],
      )

      if (updateResult.rowCount !== 1) {
        const latest = await this.loadApprovalInstance(id)
        throw new ServiceError(
          latest
            ? `Cannot ${request.action}: current status is ${latest.status}`
            : 'Approval changed during processing',
          409,
          APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION,
          latest
            ? {
                currentVersion: latest.version,
                currentStatus: latest.status,
              }
            : undefined,
        )
      }

      await client.query(
        `UPDATE approval_assignments
         SET is_active = FALSE,
             updated_at = now()
         WHERE instance_id = $1 AND is_active = TRUE`,
        [id],
      )

      await client.query(
        `INSERT INTO approval_records
         (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          request.action,
          actor.userId,
          actor.userName || null,
          request.comment || null,
          instance.status,
          nextStatus,
          instance.version,
          nextVersion,
          JSON.stringify({ sourceSystem: instance.source_system }),
          actor.ip || null,
          actor.userAgent || null,
        ],
      )

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const updated = await this.getApproval(id, actor.userId)
    if (!updated) {
      throw new ServiceError('Approval not found after action', 404, APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND)
    }
    return updated
  }

  private async fetchPlmApprovalWindow(options?: PlmSyncOptions): Promise<PlmApprovalFetch[]> {
    const plmAdapter = this.requirePlmAdapter()
    const requestedCount = Math.max(0, options?.limit ?? 50)
    if (requestedCount === 0) {
      return []
    }

    const requestedWindow = Math.min(
      PLM_SYNC_MAX_WINDOW,
      Math.max(0, options?.offset ?? 0) + requestedCount,
    )
    const approvals: PlmApprovalFetch[] = []
    let totalCount: number | null = null

    for (let pageOffset = 0; pageOffset < requestedWindow; pageOffset += PLM_SYNC_UPSTREAM_PAGE_SIZE) {
      let result
      try {
        result = await plmAdapter.getApprovals({
          status: options?.status,
          productId: options?.productId,
          requesterId: options?.requesterId,
          limit: PLM_SYNC_UPSTREAM_PAGE_SIZE,
          offset: pageOffset,
        })
      } catch (error) {
        if (isPlmBridgeUnavailableError(error)) {
          throw plmBridgeUnavailableError()
        }
        throw error
      }

      if (result.error) {
        if (isPlmBridgeUnavailableError(result.error)) {
          throw plmBridgeUnavailableError()
        }
        throw new ServiceError(
          'Failed to fetch PLM approvals',
          502,
          APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
          { upstream: String(result.error) },
        )
      }

      if (typeof result.metadata?.totalCount === 'number') {
        totalCount = result.metadata.totalCount
      }
      approvals.push(...result.data)

      if (result.data.length < PLM_SYNC_UPSTREAM_PAGE_SIZE) {
        break
      }

      if (totalCount !== null && pageOffset + result.data.length >= totalCount) {
        break
      }
    }

    return approvals.slice(0, requestedWindow)
  }

  private requirePlmAdapter(): ApprovalBridgePlmAdapter {
    if (!this.plmAdapter) {
      throw new ServiceError(
        'PLM approval bridge is not configured',
        503,
        'PLM_APPROVAL_BRIDGE_UNAVAILABLE',
      )
    }

    return this.plmAdapter
  }

  private async runInBatches<TItem, TResult>(
    items: TItem[],
    batchSize: number,
    task: (item: TItem) => Promise<TResult>,
  ): Promise<Array<PromiseSettledResult<TResult>>> {
    const results: Array<PromiseSettledResult<TResult>> = []

    for (let index = 0; index < items.length; index += batchSize) {
      const batch = items.slice(index, index + batchSize)
      results.push(...(await Promise.allSettled(batch.map(task))))
    }

    return results
  }

  private async loadApprovalInstance(id: string): Promise<ApprovalInstanceRow | null> {
    if (!pool) throw new Error('Database not available')

    const result = await pool.query<ApprovalInstanceRow>(
      'SELECT * FROM approval_instances WHERE id = $1',
      [id],
    )

    return result.rows[0] || null
  }

  /**
   * P1-C: batch-load the stored `runtime_graph` for the given published
   * definition ids so each row's `formSnapshot` can be redacted by its
   * instance-active node. Returns a map keyed by `published_definition_id`.
   * Bridged/external instances have a null `published_definition_id` and are
   * absent from the map (no redaction — they carry no node config). The raw
   * JSONB blob is returned as-is (no `asRuntimeGraph` re-validation needed on
   * the read path: redaction only reads `nodes[].key` + `config.fieldPermissions`).
   */
  private async loadRuntimeGraphs(
    publishedDefinitionIds: Array<string | null>,
  ): Promise<Map<string, RedactableRuntimeGraph>> {
    const byDefinitionId = new Map<string, RedactableRuntimeGraph>()
    const distinctIds = [...new Set(publishedDefinitionIds.filter((id): id is string => typeof id === 'string'))]
    if (!pool || distinctIds.length === 0) {
      return byDefinitionId
    }

    const result = await pool.query<{ id: string; runtime_graph: RedactableRuntimeGraph | null }>(
      `SELECT id, runtime_graph FROM approval_published_definitions WHERE id = ANY($1)`,
      [distinctIds],
    )
    for (const row of result.rows) {
      if (row.runtime_graph) {
        byDefinitionId.set(row.id, row.runtime_graph)
      }
    }
    return byDefinitionId
  }

  private async loadAssignments(instanceIds: string[]): Promise<Map<string, ApprovalAssignmentRow[]>> {
    const assignmentsByInstance = new Map<string, ApprovalAssignmentRow[]>()

    if (!pool || instanceIds.length === 0) {
      return assignmentsByInstance
    }

    const result = await pool.query<ApprovalAssignmentRow>(
      `SELECT * FROM approval_assignments
       WHERE instance_id = ANY($1)
       ORDER BY created_at ASC`,
      [instanceIds],
    )

    for (const row of result.rows) {
      const existing = assignmentsByInstance.get(row.instance_id) || []
      existing.push(row)
      assignmentsByInstance.set(row.instance_id, existing)
    }

    return assignmentsByInstance
  }

  private async loadLocalHistory(id: string): Promise<UnifiedApprovalHistoryDTO[]> {
    if (!pool) {
      return []
    }

    // Lock-5 §1.4 fact 2 / gate D-3 — the SECOND unfiltered full-timeline reader. A refused member
    // operation writes an `action:'policy_denied'` audit row (§1.4, OD-L5-9(a)); it is an
    // administrator/audit fact, not member-visible history, so it is excluded here exactly as it is
    // in `routes/approval-history.ts`. The action-FILTERED readers (`loadApprovalHistory`'s
    // `action='approve'`, the revoke window's `IN ('approve','reject','transfer')`, the threshold
    // tally, and the multitable projection's `DECISION_ACTIONS`) need no change — gate D-4 pins that
    // they do not move, with an injected real `approve` row as the non-vacuity control.
    const result = await pool.query<ApprovalRecordRow>(
      `SELECT id, action, actor_id, actor_name, comment, from_status, to_status, metadata, occurred_at
       FROM approval_records
       WHERE instance_id = $1
         AND action <> $2
       ORDER BY occurred_at DESC`,
      [id, APPROVAL_POLICY_DENIED_ACTION],
    )

    return result.rows.map((row) => ({
      id: String(row.id),
      action: row.action,
      actorId: row.actor_id,
      actorName: row.actor_name,
      comment: row.comment,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      occurredAt: toOccurredAt(row.occurred_at),
      metadata: row.metadata || {},
    }))
  }

  private resolvePlmSourceVersion(instance: ApprovalInstanceRow): number {
    const sourceVersion =
      normalizeSourceVersion(instance.metadata?.source_version) ??
      normalizeSourceVersion(instance.metadata?.sourceVersion)

    if (sourceVersion !== null) {
      return sourceVersion
    }

    throw new ServiceError(
      'PLM source version is unavailable',
      502,
      APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
      { approvalId: instance.id },
    )
  }

  private async upsertPlmMirror(source: PlmApprovalBridgeSource): Promise<void> {
    if (!pool) throw new Error('Database not available')

    const bridge = toPlatformApprovalBridgeRecord(source)
    const instanceId = createPlmApprovalInstanceId(bridge.externalApprovalId)
    const sourceUpdatedAt = source.updated_at || source.created_at || null

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      await client.query(
        `INSERT INTO approval_instances
         (id, status, version, source_system, external_approval_id, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, source_updated_at, last_synced_at, sync_status, sync_error, created_at, updated_at)
         VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, $12, now(), 'ok', NULL, now(), now())
         ON CONFLICT (source_system, external_approval_id) WHERE external_approval_id IS NOT NULL
         DO UPDATE SET
           status = EXCLUDED.status,
           workflow_key = EXCLUDED.workflow_key,
           business_key = EXCLUDED.business_key,
           title = EXCLUDED.title,
           requester_snapshot = EXCLUDED.requester_snapshot,
           subject_snapshot = EXCLUDED.subject_snapshot,
           policy_snapshot = EXCLUDED.policy_snapshot,
           metadata = EXCLUDED.metadata,
           source_updated_at = EXCLUDED.source_updated_at,
           last_synced_at = now(),
           sync_status = 'ok',
           sync_error = NULL,
           updated_at = now()`,
        [
          instanceId,
          bridge.status,
          bridge.externalSystem,
          bridge.externalApprovalId,
          bridge.workflowKey,
          bridge.businessKey,
          bridge.title,
          JSON.stringify(bridge.requester),
          JSON.stringify(bridge.subject),
          JSON.stringify(bridge.policy),
          JSON.stringify(bridge.metadata),
          sourceUpdatedAt,
        ],
      )

      const assignmentMetadata = JSON.stringify({ sourceSystem: 'plm' })

      const activeAssignmentUpdated = await client.query(
        `UPDATE approval_assignments
         SET source_step = 0,
             node_key = 'plm:source-owned',
             is_active = $2,
             metadata = $3::jsonb,
             updated_at = now()
         WHERE instance_id = $1
           AND assignment_type = 'source_queue'
           AND assignee_id = 'plm:source-owned'
           AND is_active = TRUE`,
        [
          instanceId,
          bridge.status === 'pending',
          assignmentMetadata,
        ],
      )

      if ((activeAssignmentUpdated.rowCount ?? 0) === 0) {
        await client.query(
          `INSERT INTO approval_assignments
           (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, metadata)
           VALUES ($1, 'source_queue', 'plm:source-owned', 0, 'plm:source-owned', $2, $3::jsonb)`,
          [
            instanceId,
            bridge.status === 'pending',
            assignmentMetadata,
          ],
        )
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      await this.markSyncError(instanceId, error)
      throw error
    } finally {
      client.release()
    }
  }

  private async refreshPlmInstance(id: string): Promise<void> {
    const externalApprovalId = extractExternalId(id)
    const result = await this.requirePlmAdapter().getApprovalById(externalApprovalId)

    if (result.error) {
      throw new ServiceError(
        'Failed to refresh PLM approval',
        502,
        APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
        { upstream: String(result.error) },
      )
    }

    const approval = result.data[0]
    if (!approval) {
      return
    }

    await this.upsertPlmMirror(toBridgeSource(approval))
  }

  private async getPlmHistory(id: string): Promise<UnifiedApprovalHistoryDTO[]> {
    const result = await this.requirePlmAdapter().getApprovalHistory(extractExternalId(id))

    if (result.error) {
      throw new ServiceError(
        'Failed to fetch PLM approval history',
        502,
        APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
        { upstream: String(result.error) },
      )
    }

    const sourceHistory = result.data.map((entry) => ({
      id: String(entry.id),
      action: entry.status === 'approved'
        ? 'approve'
        : entry.status === 'rejected'
          ? 'reject'
          : String(entry.status || 'unknown'),
      actorId: entry.user_id == null ? null : String(entry.user_id),
      actorName: null,
      comment: entry.comment || null,
      fromStatus: null,
      toStatus: entry.status || 'unknown',
      occurredAt: toOccurredAt(entry.approved_at, entry.created_at),
      metadata: {
        ecoId: entry.eco_id,
        stageId: entry.stage_id,
        approvalType: entry.approval_type,
        requiredRole: entry.required_role,
      },
    }))

    const localHistory = await this.loadLocalHistory(id)

    return [...sourceHistory, ...localHistory].sort(compareHistoryDescending)
  }

  private async dispatchPlmAction(id: string, version: number, request: ApprovalActionRequest): Promise<void> {
    const externalApprovalId = extractExternalId(id)
    const result = request.action === 'approve'
      ? await this.requirePlmAdapter().approveApproval(externalApprovalId, version, request.comment)
      : await this.requirePlmAdapter().rejectApproval(externalApprovalId, version, request.comment || '')

    if (result.error) {
      throw new ServiceError(
        `PLM ${request.action} failed`,
        502,
        APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
        { upstream: String(result.error) },
      )
    }
  }

  private async markSyncError(id: string, error: unknown): Promise<void> {
    if (!pool) return

    await pool.query(
      `UPDATE approval_instances
       SET sync_status = 'error',
           sync_error = $1,
           last_synced_at = now(),
           updated_at = now()
       WHERE id = $2`,
      [error instanceof Error ? error.message : String(error), id],
    )
  }
}

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}
