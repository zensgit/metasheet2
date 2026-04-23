/**
 * Shared test fixtures for approval E2E verification tests.
 *
 * All fixtures return objects conforming to the frozen contract types
 * defined in `apps/web/src/types/approval.ts`.
 */
import type {
  UnifiedApprovalDTO,
  UnifiedApprovalHistoryDTO,
  ApprovalTemplateDetailDTO,
  ApprovalAssignmentDTO,
  ApprovalGraph,
  FormSchema,
} from '../../src/types/approval'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CURRENT_USER_ID = 'user_current'
const REQUESTER_USER_ID = 'user_1'
const NOW = '2026-04-10T08:00:00Z'
const YESTERDAY = '2026-04-09T08:00:00Z'

// ---------------------------------------------------------------------------
// Reusable fragments
// ---------------------------------------------------------------------------
function defaultFormSchema(): FormSchema {
  return {
    fields: [
      { id: 'fld_reason', type: 'textarea', label: '申请原因', required: true, placeholder: '请填写申请原因' },
      { id: 'fld_amount', type: 'number', label: '金额', required: true },
      { id: 'fld_date', type: 'date', label: '期望日期', required: false },
      {
        id: 'fld_type',
        type: 'select',
        label: '类型',
        required: true,
        options: [
          { label: '采购', value: 'purchase' },
          { label: '报销', value: 'reimbursement' },
          { label: '请假', value: 'leave' },
        ],
      },
    ],
  }
}

function defaultApprovalGraph(): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '部门主管审批', config: { assigneeType: 'role', assigneeIds: ['role_manager'] } },
      { key: 'approval_2', type: 'approval', name: '财务审批', config: { assigneeType: 'user', assigneeIds: ['user_finance'] } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'approval_2' },
      { key: 'e3', source: 'approval_2', target: 'end' },
    ],
  }
}

function activeAssignment(overrides?: Partial<ApprovalAssignmentDTO>): ApprovalAssignmentDTO {
  return {
    id: 'asgn_1',
    type: 'approval',
    assigneeId: CURRENT_USER_ID,
    sourceStep: 1,
    nodeKey: 'approval_1',
    isActive: true,
    metadata: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Approval instance fixtures
// ---------------------------------------------------------------------------

/** Pending approval with an active assignment for the current user. */
export function mockPendingApproval(overrides?: Partial<UnifiedApprovalDTO>): UnifiedApprovalDTO {
  return {
    id: 'apv_pending_1',
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: null,
    businessKey: null,
    title: '出差报销申请',
    status: 'pending',
    requester: { id: REQUESTER_USER_ID, name: '张三', department: '研发部', title: '工程师' },
    subject: null,
    policy: { rejectCommentRequired: true },
    currentStep: 1,
    totalSteps: 2,
    templateId: 'tpl_1',
    templateVersionId: 'ver_1_1',
    publishedDefinitionId: 'def_1',
    requestNo: 'APV-2026-0001',
    formSnapshot: { fld_reason: '出差报销', fld_amount: 5000, fld_type: 'reimbursement' },
    currentNodeKey: 'approval_1',
    assignments: [activeAssignment()],
    createdAt: YESTERDAY,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Approved approval (terminal state). */
export function mockApprovedApproval(overrides?: Partial<UnifiedApprovalDTO>): UnifiedApprovalDTO {
  return {
    ...mockPendingApproval(),
    id: 'apv_approved_1',
    status: 'approved',
    requestNo: 'APV-2026-0002',
    currentStep: null,
    currentNodeKey: null,
    assignments: [],
    ...overrides,
  }
}

/** Rejected approval (terminal state). */
export function mockRejectedApproval(overrides?: Partial<UnifiedApprovalDTO>): UnifiedApprovalDTO {
  return {
    ...mockPendingApproval(),
    id: 'apv_rejected_1',
    status: 'rejected',
    requestNo: 'APV-2026-0003',
    currentStep: null,
    currentNodeKey: null,
    assignments: [],
    ...overrides,
  }
}

/** Revoked approval. */
export function mockRevokedApproval(overrides?: Partial<UnifiedApprovalDTO>): UnifiedApprovalDTO {
  return {
    ...mockPendingApproval(),
    id: 'apv_revoked_1',
    status: 'revoked',
    requestNo: 'APV-2026-0004',
    currentStep: null,
    currentNodeKey: null,
    assignments: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Template fixtures
// ---------------------------------------------------------------------------

/** Published template with form schema and approval graph. */
export function mockPublishedTemplate(overrides?: Partial<ApprovalTemplateDetailDTO>): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1',
    key: 'TPL-001',
    name: '通用审批模板',
    description: '适用于日常审批流程',
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    status: 'published',
    activeVersionId: 'ver_1_1',
    latestVersionId: 'ver_1_1',
    formSchema: defaultFormSchema(),
    approvalGraph: defaultApprovalGraph(),
    createdAt: YESTERDAY,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Draft template (not yet published). */
export function mockDraftTemplate(overrides?: Partial<ApprovalTemplateDetailDTO>): ApprovalTemplateDetailDTO {
  return {
    ...mockPublishedTemplate(),
    id: 'tpl_draft_1',
    key: 'TPL-DRAFT-001',
    name: '草稿审批模板',
    status: 'draft',
    activeVersionId: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// History fixtures
// ---------------------------------------------------------------------------

/** Standard history items covering creation and approval. */
export function mockHistoryItems(): UnifiedApprovalHistoryDTO[] {
  return [
    {
      id: 'hist_1',
      action: 'created',
      actorId: REQUESTER_USER_ID,
      actorName: '张三',
      comment: null,
      fromStatus: null,
      toStatus: 'pending',
      occurredAt: YESTERDAY,
      metadata: { nodeKey: 'start' },
    },
    {
      id: 'hist_2',
      action: 'approve',
      actorId: CURRENT_USER_ID,
      actorName: '当前用户',
      comment: '同意报销',
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: NOW,
      metadata: { nodeKey: 'approval_1' },
    },
  ]
}

/** History with auto-approved event. */
export function mockAutoApproveHistory(): UnifiedApprovalHistoryDTO[] {
  return [
    {
      id: 'hist_auto_1',
      action: 'created',
      actorId: REQUESTER_USER_ID,
      actorName: '张三',
      comment: null,
      fromStatus: null,
      toStatus: 'pending',
      occurredAt: YESTERDAY,
      metadata: { nodeKey: 'start' },
    },
    {
      id: 'hist_auto_2',
      action: 'approve',
      actorId: null,
      actorName: '系统',
      comment: '无审批人，自动通过',
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: NOW,
      metadata: { nodeKey: 'approval_1', autoApproved: true },
    },
  ]
}

/** History with return event and rich metadata. */
export function mockReturnHistory(): UnifiedApprovalHistoryDTO[] {
  return [
    {
      id: 'hist_ret_1',
      action: 'created',
      actorId: REQUESTER_USER_ID,
      actorName: '张三',
      comment: null,
      fromStatus: null,
      toStatus: 'pending',
      occurredAt: YESTERDAY,
      metadata: { nodeKey: 'start' },
    },
    {
      id: 'hist_ret_2',
      action: 'approve',
      actorId: CURRENT_USER_ID,
      actorName: '当前用户',
      comment: '同意',
      fromStatus: 'pending',
      toStatus: 'pending',
      occurredAt: YESTERDAY,
      metadata: { nodeKey: 'approval_1', approvalMode: 'all', aggregateComplete: true },
    },
    {
      id: 'hist_ret_3',
      action: 'return',
      actorId: 'user_3',
      actorName: '王五',
      comment: '金额有误，退回修改',
      fromStatus: 'pending',
      toStatus: 'pending',
      occurredAt: NOW,
      metadata: { nodeKey: 'approval_2', targetNodeKey: 'approval_1' },
    },
  ]
}

/** Template with approvalMode and emptyAssigneePolicy on approval nodes. */
export function mockTemplateWithModes(overrides?: Partial<ApprovalTemplateDetailDTO>): ApprovalTemplateDetailDTO {
  return {
    ...mockPublishedTemplate(),
    id: 'tpl_modes',
    name: '含模式策略模板',
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'approval_1', type: 'approval', name: '部门主管审批', config: { assigneeType: 'role', assigneeIds: ['role_manager'], approvalMode: 'all', emptyAssigneePolicy: 'error' } },
        { key: 'approval_2', type: 'approval', name: '财务审批', config: { assigneeType: 'user', assigneeIds: ['user_finance'], approvalMode: 'any', emptyAssigneePolicy: 'auto-approve' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'approval_2' },
        { key: 'e3', source: 'approval_2', target: 'end' },
      ],
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Permission mock helper
// ---------------------------------------------------------------------------

/**
 * Creates a mock user context with the specified permissions.
 * Used by permission-matrix tests to control what the current user can see/do.
 */
export function mockPermissions(perms: string[]): {
  userId: string
  userName: string
  permissions: string[]
  hasPermission: (perm: string) => boolean
} {
  return {
    userId: CURRENT_USER_ID,
    userName: '当前用户',
    permissions: perms,
    hasPermission: (perm: string) => perms.includes(perm),
  }
}

// ---------------------------------------------------------------------------
// Re-export constants for use in tests
// ---------------------------------------------------------------------------
export { CURRENT_USER_ID, REQUESTER_USER_ID, NOW, YESTERDAY }
