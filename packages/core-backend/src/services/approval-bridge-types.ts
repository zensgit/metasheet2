/**
 * Unified approval bridge types.
 *
 * These DTOs define the contract between the bridge service, the API layer,
 * and external source systems (currently PLM only in phase 1).
 */

import type { QueryResult } from '../data-adapters/BaseAdapter'
import type { ApprovalHistoryEntry, ApprovalRequest } from '../data-adapters/PLMAdapter'
import type { ApprovalNodeType, FormSchema, NodeFieldAccess } from '../types/approval-product'
import type { EffectiveNodeOperations } from './approval-effective-node-operations'

// ── Unified Approval DTO (API response shape) ──

export interface UnifiedApprovalDTO {
  id: string
  sourceSystem: string
  externalApprovalId: string | null
  workflowKey: string | null
  businessKey: string | null
  title: string | null
  status: string
  requester: ApprovalRequesterSnapshot | null
  subject: ApprovalSubjectSnapshot | null
  policy: ApprovalPolicySnapshot | null
  currentStep: number | null
  totalSteps: number | null
  templateId?: string | null
  templateVersionId?: string | null
  publishedDefinitionId?: string | null
  requestNo?: string | null
  formSnapshot?: Record<string, unknown> | null
  // Frozen form schema (detail `columns` included) from the instance's pinned template version,
  // so the read renders detail rows from the FROZEN schema, not the live template.
  formSchema?: FormSchema | null
  currentNodeKey?: string | null
  /**
   * Lock-3 §2.2 — the current node's TYPE (from the frozen runtime graph). The member 待办 surface
   * reads it to withhold approve/reject on a 办理 (handler) task. Absent ≡ not-a-handler.
   */
  currentNodeType?: ApprovalNodeType | null
  /**
   * Lock-7 OD-L7-10 — the ACTOR-SCOPED per-field access map for THIS viewer at their claimed
   * seat(s): fieldId → one NodeFieldAccess value. Present ONLY on the DETAIL read
   * (`getApproval`) — the list DTO stays byte-identical. Derived from the SAME
   * `resolveFieldAccessAtNodes` the write mask uses, so a field reported `editable` OR `required` here
   * is exactly a field the write path accepts (Lock-7B §2.2 widens the write mask to the SAME
   * `editable ∪ required` set this map is derived from — never over-reports: a seatless / role-only
   * viewer gets no map, and multi-seat is most-restrictive). Absent from the map ≡ `editable`
   * (OD-L7-9). The FE grid uses it to render `readonly` fields read-only; it is presentation only —
   * enforcement is server-side.
   */
  fieldAccess?: Record<string, NodeFieldAccess> | null
  /**
   * Lock-5 §2.3 / gate A-2 — the ACTOR-SCOPED effective per-node operation policy for THIS viewer
   * at their claimed seat(s). Present ONLY on the DETAIL read (`getApproval`) — the list DTO stays
   * byte-identical — and absent for a seatless viewer, mirroring `fieldAccess` above.
   *
   * Every field is a DECIDED value, not a config echo: the server resolves it with the SAME
   * `resolveEffectiveNodeOperations` the dispatch choke's predicate is built from, so the FE mirror
   * is not a second predicate (§2.3's "the FE mirror derives from the SAME config the server
   * enforces"). Presentation only — the 409 `APPROVAL_NODE_OPERATION_DISABLED` refusal remains the
   * authority, and hiding a button is never the guard.
   */
  nodeOperations?: EffectiveNodeOperations | null
  /**
   * Would the decision endpoint's own authorization predicate let THIS viewer decide the node the
   * instance is currently stopped on? Server-resolved per viewer, by the door's OWN predicate
   * (`approval-seat-authorization.ts`: `assignmentMatchesActor` over `decidableNodeKeysForInstance`),
   * so the client renders rather than re-derives and cannot drift from the server's answer.
   *
   * `false` when the instance is not pending, when the viewer holds no matching active seat at a
   * decidable node key, and when no viewer identity was supplied. `true` for a pending instance
   * whose decisions do NOT go through the seat-gated door (a legacy platform row with no published
   * definition, a `plm:` mirror, an after-sales row): those dispatches do not gate on assignments,
   * so `false` would hide controls the server accepts — and `true` is what those surfaces already
   * do today.
   *
   * Presentation only — the 403 `APPROVAL_ASSIGNMENT_REQUIRED` remains the authority, and hiding a
   * button is never the guard. ABSENT means "this backend does not compute it" (an older server),
   * and clients must fall back to their pre-existing behaviour rather than reading absence as
   * `false`.
   */
  canDecideCurrentNode?: boolean
  /**
   * Parallel gateway (并行分支) — populated only when the instance is in a
   * parallel region (length ≥ 2). Absent on linear state; callers that don't
   * care about parallelism keep using `currentNodeKey` unchanged.
   */
  currentNodeKeys?: string[] | null
  assignments: ApprovalAssignmentDTO[]
  /**
   * B3-02 (行级未读): per-viewer read state for the 待我处理 (pending) tab — `true` once the
   * actor has an `approval_reads` row for this instance, `false` when they do not. Populated
   * ONLY on the pending tab (the only surface the unread badge/dot semantics cover); `undefined`
   * on every other tab, where callers must treat it as "no dot" (never assume unread).
   * Mirrors the pending-count badge's unread predicate exactly (absence of an approval_reads row).
   */
  isRead?: boolean
  createdAt: string
  updatedAt: string
}

export interface ApprovalRequesterSnapshot {
  id?: string
  name?: string
}

export interface ApprovalSubjectSnapshot {
  productId?: string
  productNumber?: string
  productName?: string
  [key: string]: unknown
}

export interface ApprovalPolicySnapshot {
  rejectCommentRequired?: boolean
  sourceOfTruth?: string
  [key: string]: unknown
}

export interface ApprovalAssignmentDTO {
  id: string
  type: string
  assigneeId: string
  sourceStep: number
  nodeKey?: string | null
  isActive: boolean
  metadata: Record<string, unknown>
}

// ── Unified History DTO ──

export interface UnifiedApprovalHistoryDTO {
  id: string
  action: string
  actorId: string | null
  actorName: string | null
  comment: string | null
  fromStatus: string | null
  toStatus: string
  occurredAt: string | null
  metadata: Record<string, unknown>
}

// ── Query Options ──

/**
 * The list feed's tab values, as ONE definition. The route's admission check and the query
 * option's own type are both derived from this tuple, so a tab added here cannot be accepted by
 * one and rejected by the other, and a hand-typed array in the route can no longer drift from the
 * union the service branches on.
 *
 * `tab` is a FILTER WITHIN the server-determined visibility scope, never the thing that decides
 * whether a scope is applied at all — see `buildApprovalListScopeCondition` in
 * `ApprovalBridgeService.ts`, which is conjoined into every list query regardless of this value.
 */
export const APPROVAL_LIST_TABS = ['pending', 'mine', 'cc', 'completed', 'processed'] as const

export type ApprovalListTab = (typeof APPROVAL_LIST_TABS)[number]

export function isApprovalListTab(value: string): value is ApprovalListTab {
  return (APPROVAL_LIST_TABS as readonly string[]).includes(value)
}

/**
 * The tab a list request with NO `tab` parameter is served with. `pending` (待我处理) is the
 * inbox's own landing tab — `apps/web/src/approvals/store.ts` never issues a tab-less request, and
 * its first fetch is `fetchPending` — so the documented default matches what the only in-repo
 * client already asks for on load, rather than inventing an "everything" mode with no UI behind it.
 */
export const APPROVAL_LIST_DEFAULT_TAB: ApprovalListTab = 'pending'

export interface ApprovalQueryOptions {
  sourceSystem?: string
  status?: string
  workflowKey?: string
  businessKey?: string
  assignee?: string
  search?: string
  /**
   * B3-03 (模板/时间筛选): narrow the feed to one published template + a created-at window.
   * `templateId` matches `approval_instances.template_id`; `createdFrom`/`createdTo` are
   * inclusive ISO timestamps compared against `approval_instances.created_at`. Additive — compose
   * with `tab`/`sourceSystem`/every other filter, never replace them.
   */
  templateId?: string
  createdFrom?: string
  createdTo?: string
  /**
   * B3-01 adds `processed` (我已处理): every instance the actor has ANY `approval_records` row
   * for (a reverse lookup on `actor_id`), regardless of the instance's CURRENT status — unlike
   * `completed`, which is scoped to non-pending instances.
   */
  tab?: ApprovalListTab
  /**
   * TRUE when `tab` carries `APPROVAL_LIST_DEFAULT_TAB` because the request supplied none, as
   * opposed to naming that same value explicitly. The ONLY thing it changes is the legacy "a tab
   * implies the platform feed" source conjunct in `listApprovals`: a request that named no tab
   * keeps the mixed platform+plm feed it has always been served, instead of being narrowed to
   * platform rows as a side effect of the tab defaulting. Absent/false ⇒ the legacy rule applies,
   * so every existing caller (including a direct service call naming a tab) is unaffected.
   */
  tabDefaulted?: boolean
  includeExternalTabSources?: boolean
  actorId?: string
  actorRoles?: string[]
  actorPermissions?: string[]
  limit?: number
  offset?: number
}

// ── Sync Options ──

export interface PlmSyncOptions {
  status?: string
  productId?: string
  requesterId?: string
  limit?: number
  offset?: number
}

// ── Action Request ──

export interface ApprovalActionRequest {
  action: 'approve' | 'reject' | 'transfer' | 'revoke' | 'comment'
  comment?: string
  targetUserId?: string
}

export interface ApprovalBridgePlmAdapter {
  getApprovals(options?: PlmSyncOptions): Promise<QueryResult<ApprovalRequest>>
  getApprovalById(approvalId: string): Promise<QueryResult<ApprovalRequest>>
  getApprovalHistory(approvalId: string): Promise<QueryResult<ApprovalHistoryEntry>>
  approveApproval(approvalId: string, version: number, comment?: string): Promise<QueryResult<Record<string, unknown>>>
  rejectApproval(approvalId: string, version: number, comment: string): Promise<QueryResult<Record<string, unknown>>>
}

// ── Error Codes ──

export const APPROVAL_ERROR_CODES = {
  ASSIGNEE_FILTER_UNSUPPORTED: 'ASSIGNEE_FILTER_UNSUPPORTED',
  SOURCE_ACTION_FAILED: 'SOURCE_ACTION_FAILED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  REJECT_COMMENT_REQUIRED: 'REJECT_COMMENT_REQUIRED',
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  /** A non-empty `tab` value that is not in `APPROVAL_LIST_TABS`. An EMPTY `tab` is absent, not
   *  invalid — matching how `sourceSystem` / `templateId` / `createdFrom` / `createdTo` already
   *  treat a cleared filter chip, so clearing a tab degrades to the default rather than 400ing. */
  TAB_INVALID: 'APPROVAL_TAB_INVALID',
} as const

// ── DB Row Types (internal, not exposed via API) ──

export interface ApprovalInstanceRow {
  id: string
  status: string
  version: number
  source_system: string
  external_approval_id: string | null
  workflow_key: string | null
  business_key: string | null
  title: string | null
  requester_snapshot: Record<string, unknown>
  subject_snapshot: Record<string, unknown>
  policy_snapshot: Record<string, unknown>
  metadata: Record<string, unknown>
  current_step: number
  total_steps: number
  source_updated_at: Date | null
  last_synced_at: Date | null
  sync_status: string
  sync_error: string | null
  template_id: string | null
  template_version_id: string | null
  published_definition_id: string | null
  request_no: string | null
  form_snapshot: Record<string, unknown> | null
  current_node_key: string | null
  created_at: Date
  updated_at: Date
}

export interface ApprovalAssignmentRow {
  id: string
  instance_id: string
  assignment_type: string
  assignee_id: string
  source_step: number
  node_key: string | null
  is_active: boolean
  metadata: Record<string, unknown>
  // nodeEntryEpoch (design-lock 2026-07-03): the instance's node_activation_seq at the
  // activation that created this assignment. NULL for pre-migration (legacy) rows.
  entry_epoch?: number | null
  created_at: Date
  updated_at: Date
}
