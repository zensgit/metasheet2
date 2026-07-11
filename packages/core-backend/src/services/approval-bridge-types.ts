/**
 * Unified approval bridge types.
 *
 * These DTOs define the contract between the bridge service, the API layer,
 * and external source systems (currently PLM only in phase 1).
 */

import type { QueryResult } from '../data-adapters/BaseAdapter'
import type { ApprovalHistoryEntry, ApprovalRequest } from '../data-adapters/PLMAdapter'
import type { FormSchema } from '../types/approval-product'

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
  tab?: 'pending' | 'mine' | 'cc' | 'completed' | 'processed'
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
