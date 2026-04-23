/**
 * Approval API Client
 *
 * Typed functions wrapping /api/approval-templates and /api/approvals endpoints.
 * Uses apiFetch/apiGet/apiPost from project utils.
 * Includes mock fallback for development when backend is not available.
 */
import { apiFetch, apiGet, apiPost } from '../utils/api'
import type {
  ApprovalTemplateListItemDTO,
  ApprovalTemplateDetailDTO,
  ApprovalTemplateVersionDetailDTO,
  UnifiedApprovalDTO,
  UnifiedApprovalHistoryDTO,
  CreateApprovalRequest,
  ApprovalActionRequest,
  ApprovalStatus,
  ApprovalTemplateStatus,
  FormField,
} from '../types/approval'

// ---------------------------------------------------------------------------
// Mock-mode flag
// ---------------------------------------------------------------------------
const USE_MOCK = import.meta.env.DEV || (globalThis as any).__APPROVAL_MOCK__ === true

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------
function mockTemplateListItem(index: number): ApprovalTemplateListItemDTO {
  const statuses: ApprovalTemplateStatus[] = ['published', 'draft', 'archived']
  return {
    id: `tpl_${index}`,
    key: `TPL-${String(index).padStart(3, '0')}`,
    name: `审批模板 ${index}`,
    description: index % 2 === 0 ? '通用审批模板' : null,
    status: statuses[index % statuses.length],
    activeVersionId: statuses[index % statuses.length] === 'published' ? `ver_${index}_1` : null,
    latestVersionId: `ver_${index}_1`,
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - index * 3600000).toISOString(),
  }
}

function mockFormFields(): FormField[] {
  return [
    { id: 'fld_reason', type: 'textarea', label: '申请原因', required: true, placeholder: '请填写申请原因' },
    { id: 'fld_amount', type: 'number', label: '金额', required: true },
    { id: 'fld_date', type: 'date', label: '期望日期', required: false },
    { id: 'fld_type', type: 'select', label: '类型', required: true, options: [
      { label: '采购', value: 'purchase' },
      { label: '报销', value: 'reimbursement' },
      { label: '请假', value: 'leave' },
    ]},
    { id: 'fld_tags', type: 'multi-select', label: '标签', required: false, options: [
      { label: '紧急', value: 'urgent' },
      { label: '常规', value: 'normal' },
    ]},
    { id: 'fld_assignee', type: 'user', label: '经办人', required: false },
    { id: 'fld_attachment', type: 'attachment', label: '附件', required: false },
  ]
}

function mockTemplateDetail(id: string): ApprovalTemplateDetailDTO {
  return {
    ...mockTemplateListItem(1),
    id,
    status: 'published',
    activeVersionId: 'ver_1_1',
    formSchema: { fields: mockFormFields() },
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
  }
}

function mockVersionDetail(templateId: string, versionId: string): ApprovalTemplateVersionDetailDTO {
  const detail = mockTemplateDetail(templateId)
  return {
    id: versionId,
    templateId,
    version: 1,
    status: 'published',
    formSchema: detail.formSchema,
    approvalGraph: detail.approvalGraph,
    runtimeGraph: {
      ...detail.approvalGraph,
      policy: { allowRevoke: true, revokeBeforeNodeKeys: ['approval_2'] },
    },
    publishedDefinitionId: 'def_1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function mockApproval(index: number): UnifiedApprovalDTO {
  const statuses: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'revoked', 'cancelled']
  const status = statuses[index % statuses.length]
  // Surface an any-mode fixture on a stable slot so dev-mode always exercises the UI branch.
  const isAnyModeFixture = index % 5 === 1
  // Surface a parallel-gateway fixture on a stable slot so dev-mode always
  // exercises the `currentNodeKeys` → "并行中" UI path. Parallel wins over
  // any-mode on that slot because the any-mode badge already renders on many
  // other indices.
  const isParallelFixture = index % 7 === 3
  const baseAssignmentNodeKey = isParallelFixture
    ? 'parallel_fork'
    : isAnyModeFixture ? 'approval_any' : 'approval_1'
  return {
    id: `apv_${index}`,
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: null,
    businessKey: null,
    title: `审批申请 #${1000 + index}`,
    status,
    requester: { id: 'user_1', name: '张三', department: '研发部', title: '工程师' },
    subject: null,
    policy: { rejectCommentRequired: true },
    currentStep: status === 'pending' ? 1 : null,
    totalSteps: 2,
    templateId: 'tpl_1',
    templateVersionId: 'ver_1_1',
    publishedDefinitionId: 'def_1',
    requestNo: `AP-${String(100000 + index)}`,
    formSnapshot: { fld_reason: '出差报销', fld_amount: 5000, fld_type: 'reimbursement' },
    currentNodeKey: status === 'pending' ? baseAssignmentNodeKey : null,
    ...(status === 'pending' && isParallelFixture
      ? { currentNodeKeys: ['legal_review', 'compliance_review'] as string[] }
      : {}),
    assignments: status === 'pending'
      ? (isParallelFixture
        ? [
          {
            id: `asgn_${index}_legal`,
            type: 'approval',
            assigneeId: 'user_legal',
            sourceStep: 1,
            nodeKey: 'legal_review',
            isActive: true,
            metadata: {},
          },
          {
            id: `asgn_${index}_compliance`,
            type: 'approval',
            assigneeId: 'user_compliance',
            sourceStep: 1,
            nodeKey: 'compliance_review',
            isActive: true,
            metadata: {},
          },
        ]
        : isAnyModeFixture
        ? [
          {
            id: `asgn_${index}_a`,
            type: 'approval',
            assigneeId: 'user_current',
            sourceStep: 1,
            nodeKey: baseAssignmentNodeKey,
            isActive: true,
            metadata: {},
          },
          {
            id: `asgn_${index}_b`,
            type: 'approval',
            assigneeId: 'user_other',
            sourceStep: 1,
            nodeKey: baseAssignmentNodeKey,
            isActive: true,
            metadata: {},
          },
        ]
        : [
          {
            id: `asgn_${index}`,
            type: 'approval',
            assigneeId: 'user_current',
            sourceStep: 1,
            nodeKey: baseAssignmentNodeKey,
            isActive: true,
            metadata: {},
          },
        ])
      : [],
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - index * 3600000).toISOString(),
  }
}

function mockHistory(approvalId: string): UnifiedApprovalHistoryDTO[] {
  // Dev-mode fixture: preserve the existing workflow story then append an any-mode (或签)
  // completion event so the timeline exercises the first-wins aggregateCancelled path.
  return [
    {
      id: 'hist_1',
      action: 'created',
      actorId: 'user_1',
      actorName: '张三',
      comment: null,
      fromStatus: null,
      toStatus: 'pending',
      occurredAt: new Date(Date.now() - 86400000 * 3).toISOString(),
      metadata: { nodeKey: 'start' },
    },
    {
      id: 'hist_2',
      action: 'approve',
      actorId: 'user_2',
      actorName: '李四',
      comment: '同意',
      fromStatus: 'pending',
      toStatus: 'pending',
      occurredAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      metadata: { nodeKey: 'approval_1', approvalMode: 'all', aggregateComplete: true },
    },
    {
      id: 'hist_3',
      action: 'approve',
      actorId: null,
      actorName: '系统',
      comment: '无审批人，自动通过',
      fromStatus: 'pending',
      toStatus: 'pending',
      occurredAt: new Date(Date.now() - 86400000).toISOString(),
      metadata: { nodeKey: 'approval_2', autoApproved: true },
    },
    {
      id: 'hist_4',
      action: 'return',
      actorId: 'user_3',
      actorName: '王五',
      comment: '金额有误，退回修改',
      fromStatus: 'pending',
      toStatus: 'pending',
      occurredAt: new Date(Date.now() - 3600000).toISOString(),
      metadata: { nodeKey: 'approval_3', targetNodeKey: 'approval_1' },
    },
    {
      id: 'hist_5',
      action: 'approve',
      actorId: 'user_2',
      actorName: '李四',
      comment: '重新审批通过',
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: new Date().toISOString(),
      metadata: { nodeKey: 'approval_1' },
    },
    {
      id: 'hist_6',
      action: 'approve',
      actorId: 'user_7',
      actorName: '赵六',
      comment: '先行审批',
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: new Date().toISOString(),
      metadata: {
        nodeKey: 'approval_any',
        approvalMode: 'any',
        aggregateComplete: true,
        aggregateCancelled: ['user_8'],
      },
    },
    {
      id: 'hist_7',
      action: 'sign',
      actorId: 'system',
      actorName: '系统',
      comment: null,
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: new Date().toISOString(),
      metadata: {
        nodeKey: 'approval_any',
        autoCancelled: true,
        aggregateMode: 'any',
        aggregateCancelledBy: 'user_7',
        cancelledAssignees: ['user_8'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Query interfaces
// ---------------------------------------------------------------------------
export interface TemplateListQuery {
  status?: ApprovalTemplateStatus
  search?: string
  page?: number
  pageSize?: number
}

export interface ApprovalListQuery {
  tab?: 'pending' | 'mine' | 'cc' | 'completed'
  status?: ApprovalStatus
  search?: string
  page?: number
  pageSize?: number
  /**
   * Wave 2 WP2: drives the unified Inbox source filter tab.
   *   - 'all'      → mixed feed (platform + PLM)
   *   - 'platform' → platform-owned only
   *   - 'plm'      → PLM-mirrored only
   */
  sourceSystem?: 'all' | 'platform' | 'plm'
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function listTemplates(
  query?: TemplateListQuery,
): Promise<{ data: ApprovalTemplateListItemDTO[]; total: number }> {
  if (USE_MOCK) {
    let items = Array.from({ length: 12 }, (_, i) => mockTemplateListItem(i + 1))
    if (query?.status) items = items.filter((t) => t.status === query.status)
    if (query?.search) {
      const q = query.search.toLowerCase()
      items = items.filter((t) => t.name.toLowerCase().includes(q))
    }
    const page = query?.page ?? 1
    const pageSize = query?.pageSize ?? 10
    const start = (page - 1) * pageSize
    return { data: items.slice(start, start + pageSize), total: items.length }
  }
  const params = new URLSearchParams()
  if (query?.status) params.set('status', query.status)
  if (query?.search) params.set('search', query.search)
  if (query?.page) params.set('page', String(query.page))
  if (query?.pageSize) params.set('pageSize', String(query.pageSize))
  const qs = params.toString()
  return apiGet(`/api/approval-templates${qs ? `?${qs}` : ''}`)
}

export async function getTemplate(id: string): Promise<ApprovalTemplateDetailDTO> {
  if (USE_MOCK) return mockTemplateDetail(id)
  return apiGet(`/api/approval-templates/${id}`)
}

export async function getTemplateVersion(
  templateId: string,
  versionId: string,
): Promise<ApprovalTemplateVersionDetailDTO> {
  if (USE_MOCK) return mockVersionDetail(templateId, versionId)
  return apiGet(`/api/approval-templates/${templateId}/versions/${versionId}`)
}

export async function listApprovals(
  query?: ApprovalListQuery,
): Promise<{ data: UnifiedApprovalDTO[]; total: number }> {
  if (USE_MOCK) {
    let items = Array.from({ length: 25 }, (_, i) => mockApproval(i + 1))
    if (query?.tab === 'pending') items = items.filter((a) => a.status === 'pending')
    else if (query?.tab === 'mine') items = items.filter((a) => a.requester?.id === 'user_1')
    else if (query?.tab === 'cc') items = items.slice(0, 3)
    else if (query?.tab === 'completed') items = items.filter((a) => ['approved', 'rejected', 'revoked'].includes(a.status))
    if (query?.status) items = items.filter((a) => a.status === query.status)
    if (query?.search) {
      const q = query.search.toLowerCase()
      items = items.filter((a) => (a.title ?? '').toLowerCase().includes(q) || (a.requestNo ?? '').toLowerCase().includes(q))
    }
    const page = query?.page ?? 1
    const pageSize = query?.pageSize ?? 10
    const start = (page - 1) * pageSize
    return { data: items.slice(start, start + pageSize), total: items.length }
  }
  const params = new URLSearchParams()
  if (query?.tab) params.set('tab', query.tab)
  if (query?.status) params.set('status', query.status)
  if (query?.search) params.set('search', query.search)
  if (query?.page) params.set('page', String(query.page))
  if (query?.pageSize) params.set('pageSize', String(query.pageSize))
  if (query?.sourceSystem) params.set('sourceSystem', query.sourceSystem)
  const qs = params.toString()
  return apiGet(`/api/approvals${qs ? `?${qs}` : ''}`)
}

export async function getApproval(id: string): Promise<UnifiedApprovalDTO> {
  if (USE_MOCK) return mockApproval(parseInt(id.replace('apv_', ''), 10) || 1)
  return apiGet(`/api/approvals/${id}`)
}

export async function getApprovalHistory(id: string): Promise<UnifiedApprovalHistoryDTO[]> {
  if (USE_MOCK) return mockHistory(id)
  return apiGet(`/api/approvals/${id}/history`)
}

export async function createApproval(req: CreateApprovalRequest): Promise<UnifiedApprovalDTO> {
  if (USE_MOCK) {
    return {
      ...mockApproval(999),
      id: `apv_${Date.now()}`,
      status: 'pending',
      templateId: req.templateId,
      formSnapshot: req.formData as Record<string, unknown>,
    }
  }
  return apiPost('/api/approvals', req)
}

/**
 * Wave 2 WP3 slice 1 — pending count (红点数据源).
 *
 * Returns the total active-assignment count for the current user, scoped by
 * source system. Used by the 待办 tab badge; the response is intentionally
 * scalar so the caller does not need to fetch the full list just to render
 * the indicator.
 *
 * Wave 2 WP3 slice 2 extends the response with `unreadCount`: the subset of
 * the same assignments whose `approval_reads` row has not been written for
 * the current user. The badge switches to `unreadCount` as the primary
 * semantic ("有未读"); `count` is still exposed so callers can render a
 * "待办 X (其中 Y 未读)" tooltip.
 */
export interface PendingCountResponse {
  count: number
  unreadCount: number
  degraded?: boolean
}

export async function getPendingCount(
  sourceSystem: 'all' | 'platform' | 'plm' = 'all',
): Promise<PendingCountResponse> {
  if (USE_MOCK) {
    const fallback = sourceSystem === 'platform' ? 2 : sourceSystem === 'plm' ? 1 : 3
    // Mock mode: mirror the server's additive contract — treat every pending
    // row as unread so the dev-mode badge matches the list below.
    return { count: fallback, unreadCount: fallback }
  }
  const qs = sourceSystem ? `?sourceSystem=${encodeURIComponent(sourceSystem)}` : ''
  return apiGet(`/api/approvals/pending-count${qs}`)
}

/**
 * Wave 2 WP3 slice 2 — mark a single approval as read for the current user.
 *
 * Used by `ApprovalDetailView` on-mount (fire-and-forget). The endpoint is
 * idempotent — a second call simply refreshes `read_at`. A missing instance
 * (unsynced PLM edge) is reported as `{ ok:true, skipped:true }` so the
 * detail view never surfaces a noisy error.
 */
export interface MarkApprovalReadResponse {
  ok: boolean
  skipped?: boolean
  reason?: string
}

export async function markApprovalRead(id: string): Promise<MarkApprovalReadResponse> {
  if (USE_MOCK) {
    return { ok: true }
  }
  return apiPost(`/api/approvals/${encodeURIComponent(id)}/mark-read`, {})
}

/**
 * Wave 2 WP3 slice 2 — mark every active assignment as read for the current
 * user. Used by the 审批中心 "全部标记已读" action; honours the 待办 tab's
 * current `sourceSystem` filter so the user's intent ("clear my unread badge
 * for this tab") is preserved.
 */
export interface MarkAllApprovalsReadResponse {
  markedCount: number
}

export async function markAllApprovalsRead(
  sourceSystem: 'all' | 'platform' | 'plm' = 'all',
): Promise<MarkAllApprovalsReadResponse> {
  if (USE_MOCK) {
    const fallback = sourceSystem === 'platform' ? 2 : sourceSystem === 'plm' ? 1 : 3
    return { markedCount: fallback }
  }
  return apiPost(`/api/approvals/mark-all-read`, { sourceSystem })
}

/**
 * Wave 2 WP3 slice 1 — 催办 result shape. Exposes the 429 throttle state so
 * the UI can surface "已在 N 分钟前催办过" instead of a generic error.
 */
export type RemindApprovalResult =
  | {
      ok: true
      data: {
        id: string
        action: 'remind'
        remindedAt: string
        bridged: boolean
        sourceSystem: string | null
      }
    }
  | {
      ok: false
      error: {
        code: string
        message: string
        lastRemindedAt?: string
        retryAfterSeconds?: number
      }
      status: number
    }

/**
 * Send a remind event on an approval instance.
 *
 * Uses `apiFetch` directly (not `apiPost`) so the caller can branch on the
 * 429 rate-limit status without losing the `lastRemindedAt` hint carried in
 * the response body.
 */
export async function remindApproval(id: string): Promise<RemindApprovalResult> {
  if (USE_MOCK) {
    return {
      ok: true,
      data: {
        id,
        action: 'remind',
        remindedAt: new Date().toISOString(),
        bridged: false,
        sourceSystem: 'platform',
      },
    }
  }
  const response = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/remind`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  const payload = await response.json().catch(() => null)
  if (response.status === 429) {
    return {
      ok: false,
      error: {
        code: payload?.error?.code ?? 'APPROVAL_REMIND_THROTTLED',
        message: payload?.error?.message ?? 'Remind is rate-limited',
        lastRemindedAt: payload?.error?.lastRemindedAt,
        retryAfterSeconds: payload?.error?.retryAfterSeconds,
      },
      status: 429,
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: payload?.error?.code ?? 'APPROVAL_REMIND_FAILED',
        message: payload?.error?.message ?? `API error: ${response.status} ${response.statusText}`,
      },
      status: response.status,
    }
  }
  return payload as RemindApprovalResult
}

export async function dispatchAction(
  id: string,
  req: ApprovalActionRequest,
): Promise<UnifiedApprovalDTO> {
  if (USE_MOCK) {
    const base = mockApproval(parseInt(id.replace('apv_', ''), 10) || 1)
    const statusMap: Record<string, string> = {
      approve: 'approved',
      reject: 'rejected',
      revoke: 'revoked',
      transfer: 'pending',
      return: 'pending',
    }
    return { ...base, status: statusMap[req.action] ?? base.status }
  }
  return apiPost(`/api/approvals/${id}/actions`, req)
}
