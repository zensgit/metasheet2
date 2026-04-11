/**
 * Approval API Client
 *
 * Typed functions wrapping /api/approval-templates and /api/approvals endpoints.
 * Uses apiFetch/apiGet/apiPost from project utils.
 * Includes mock fallback for development when backend is not available.
 */
import { apiGet, apiPost } from '../utils/api'
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
        { key: 'approval_1', type: 'approval', name: '部门主管审批', config: { assigneeType: 'role', assigneeIds: ['role_manager'] } },
        { key: 'approval_2', type: 'approval', name: '财务审批', config: { assigneeType: 'user', assigneeIds: ['user_finance'] } },
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
  const statuses: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'revoked', 'draft']
  const status = statuses[index % statuses.length]
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
    requestNo: `APV-2026-${String(index).padStart(4, '0')}`,
    formSnapshot: { fld_reason: '出差报销', fld_amount: 5000, fld_type: 'reimbursement' },
    currentNodeKey: status === 'pending' ? 'approval_1' : null,
    assignments: status === 'pending' ? [{
      id: `asgn_${index}`,
      type: 'approval',
      assigneeId: 'user_current',
      sourceStep: 1,
      nodeKey: 'approval_1',
      isActive: true,
      metadata: {},
    }] : [],
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - index * 3600000).toISOString(),
  }
}

function mockHistory(approvalId: string): UnifiedApprovalHistoryDTO[] {
  return [
    {
      id: 'hist_1',
      action: 'created',
      actorId: 'user_1',
      actorName: '张三',
      comment: null,
      fromStatus: null,
      toStatus: 'pending',
      occurredAt: new Date(Date.now() - 86400000).toISOString(),
      metadata: {},
    },
    {
      id: 'hist_2',
      action: 'approve',
      actorId: 'user_2',
      actorName: '李四',
      comment: '同意',
      fromStatus: 'pending',
      toStatus: 'approved',
      occurredAt: new Date().toISOString(),
      metadata: {},
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
    }
    return { ...base, status: statusMap[req.action] ?? base.status }
  }
  return apiPost(`/api/approvals/${id}/actions`, req)
}
