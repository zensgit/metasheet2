/**
 * Unified approval bridge types.
 *
 * These DTOs define the contract between the bridge service, the API layer,
 * and external source systems (currently PLM only in phase 1).
 */

import type { QueryResult } from '../data-adapters/BaseAdapter'
import type { ApprovalHistoryEntry, ApprovalRequest } from '../data-adapters/PLMAdapter'

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
  currentStep: number
  totalSteps: number
  assignments: ApprovalAssignmentDTO[]
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
  occurredAt: string
  metadata: Record<string, unknown>
}

// ── Query Options ──

export interface ApprovalQueryOptions {
  sourceSystem?: string
  status?: string
  workflowKey?: string
  businessKey?: string
  assignee?: string
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
  action: 'approve' | 'reject'
  comment?: string
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
  created_at: Date
  updated_at: Date
}

export interface ApprovalAssignmentRow {
  id: string
  instance_id: string
  assignment_type: string
  assignee_id: string
  source_step: number
  is_active: boolean
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}
