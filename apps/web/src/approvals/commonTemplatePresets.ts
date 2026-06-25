import { APPROVAL_ROLE_CONFIGURE_SENTINEL } from '../types/approval'
import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  CreateApprovalTemplateRequest,
  EmptyAssigneePolicy,
  FormField,
  FormSchema,
} from '../types/approval'

export type CommonApprovalTemplatePresetId =
  | 'leave'
  | 'reimbursement'
  | 'purchase'
  | 'reimbursement_amount_tier'
  | 'purchase_amount_tier'

export interface CommonApprovalTemplatePreset {
  id: CommonApprovalTemplatePresetId
  title: string
  category: string
  description: string
}

export interface BuildCommonApprovalTemplatePresetOptions {
  /**
   * Test hook / deterministic import hook. Runtime callers omit it so repeated clicks
   * create distinct draft keys.
   */
  keySuffix?: string
}

interface CommonApprovalTemplateStep {
  name: string
  source: ApprovalAssigneeSource
  approvalMode?: ApprovalMode
  emptyAssigneePolicy?: EmptyAssigneePolicy
}

export const COMMON_APPROVAL_TEMPLATE_PRESETS: CommonApprovalTemplatePreset[] = [
  {
    id: 'leave',
    title: '请假审批',
    category: '请假',
    description: '请假类型、起止日期、天数、事由与工作交接人。',
  },
  {
    id: 'reimbursement',
    title: '报销审批',
    category: '报销',
    description: '费用类型、金额、报销明细、事由与逐级审核。',
  },
  {
    id: 'purchase',
    title: '采购审批',
    category: '采购',
    description: '采购类型、供应商、预算负责人、物品明细与逐级审核。',
  },
  {
    id: 'reimbursement_amount_tier',
    title: '报销审批（金额分级）',
    category: '报销',
    description: '高额报销自动升级：金额达阈值时增加部门主管审批（阈值/审批人可调）。',
  },
  {
    id: 'purchase_amount_tier',
    title: '采购审批（金额分级）',
    category: '采购',
    description: '高额采购升级并行会签：金额达阈值时由上级经理与指定角色并行审批（阈值/汇聚模式/审批人可调）。',
  },
]

function nextPresetKeySuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function field(
  id: string,
  type: FormField['type'],
  label: string,
  options: Partial<FormField> = {},
): FormField {
  return { id, type, label, ...options }
}

function selectField(id: string, label: string, values: string[], options: Partial<FormField> = {}): FormField {
  return field(id, 'select', label, {
    required: true,
    options: values.map((value) => ({ label: value, value })),
    ...options,
  })
}

function approvalStep(
  index: number,
  name: string,
  source: ApprovalAssigneeSource,
  options: {
    approvalMode?: ApprovalMode
    emptyAssigneePolicy?: EmptyAssigneePolicy
  } = {},
): ApprovalGraph['nodes'][number] {
  return {
    key: `approval_${index}`,
    type: 'approval',
    name,
    config: {
      assigneeSources: [source],
      approvalMode: options.approvalMode ?? 'single',
      emptyAssigneePolicy: options.emptyAssigneePolicy ?? 'error',
    },
  }
}

function linearGraph(steps: CommonApprovalTemplateStep[]): ApprovalGraph {
  const nodes: ApprovalGraph['nodes'] = [
    { key: 'start', type: 'start', name: '发起', config: {} },
    ...steps.map((step, index) => approvalStep(index + 1, step.name, step.source, step)),
    { key: 'end', type: 'end', name: '结束', config: {} },
  ]
  const keys = nodes.map((node) => node.key)
  return {
    nodes,
    edges: keys.slice(0, -1).map((source, index) => ({
      key: `edge-${source}-${keys[index + 1]}`,
      source,
      target: keys[index + 1],
    })),
  }
}

function detailField(id: string, label: string, columns: FormField[], minRows = 1): FormField {
  return field(id, 'detail', label, {
    required: true,
    columns,
    minRows,
  })
}

function leaveSchema(): FormSchema {
  return {
    fields: [
      selectField('leave_type', '请假类型', ['年假', '事假', '病假', '调休', '其他']),
      field('start_date', 'date', '开始日期', { required: true }),
      field('end_date', 'date', '结束日期', { required: true }),
      field('leave_days', 'number', '请假天数', {
        required: true,
        props: { min: 0.5, step: 0.5 },
      }),
      field('reason', 'textarea', '请假事由', { required: true, placeholder: '请填写请假原因' }),
      field('handover_user', 'user', '工作交接人'),
    ],
  }
}

function reimbursementSchema(): FormSchema {
  return {
    fields: [
      selectField('expense_type', '费用类型', ['差旅', '交通', '餐饮', '办公', '其他']),
      field('expense_date', 'date', '费用日期', { required: true }),
      // Amount-tier templates (those declaring amountConsistencyCheck) auto-sum this from the detail
      // rows in the fill UI (read-only, design-lock #3189); a template without the mapping keeps it
      // applicant-entered.
      field('amount', 'number', '报销金额', {
        required: true,
        props: { min: 0 },
      }),
      detailField('expense_items', '报销明细', [
        field('item', 'text', '项目', { required: true }),
        selectField('category', '类别', ['交通', '住宿', '餐饮', '办公', '其他']),
        field('amount', 'number', '金额', { required: true, props: { min: 0 } }),
        field('note', 'text', '备注'),
      ]),
      field('reason', 'textarea', '报销说明', { placeholder: '请说明费用用途' }),
    ],
  }
}

function purchaseSchema(): FormSchema {
  return {
    fields: [
      selectField('purchase_type', '采购类型', ['办公用品', '设备', '服务', '软件', '其他']),
      field('supplier', 'text', '供应商', { required: true }),
      // Amount-tier templates (those declaring amountConsistencyCheck) auto-sum this from the detail
      // rows in the fill UI (read-only, design-lock #3189); a template without the mapping keeps it
      // applicant-entered.
      field('amount', 'number', '预算金额', {
        required: true,
        props: { min: 0 },
      }),
      field('budget_owner', 'user', '预算负责人', { required: true }),
      detailField('purchase_items', '采购明细', [
        field('name', 'text', '物品/服务', { required: true }),
        field('spec', 'text', '规格'),
        field('quantity', 'number', '数量', { required: true, props: { min: 1 } }),
        field('unit_price', 'number', '单价', { required: true, props: { min: 0 } }),
        field('amount', 'number', '小计', { props: { min: 0 } }),
        field('note', 'text', '备注'),
      ]),
      field('reason', 'textarea', '采购说明', { required: true, placeholder: '请说明采购必要性' }),
    ],
  }
}

// Server-side amount total-check (design-lock #3161): attach the consistency mapping so the amount-tier
// presets are protected by default — the backend rejects a submission whose top-level total ≠ the sum of
// the detail-row amounts (closing the under-stated-total bypass of the higher tier). The basic presets
// keep no mapping. The backend validates + persists it; the FE just declares it.
function withAmountConsistency(
  schema: FormSchema,
  totalFieldId: string,
  detailFieldId: string,
  amountColumnId: string,
): FormSchema {
  return { ...schema, amountConsistencyCheck: { totalFieldId, detailFieldId, amountColumnId } }
}

// Amount-tier reimbursement (design-lock #3114): a condition node gates a higher-tier approver on the
// top-level `amount`. Low amount → end after the direct manager; amount ≥ threshold → a dept-head
// (higher-tier) approval before end. Default threshold 5000, editable in the condition-node rule
// (Gate-A). The branch reads the top-level `amount` total (detail-row auto-sum is a separate
// form-field capability, not this slice — design-lock Decision 1).
function reimbursementAmountTierGraph(): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '直属上级审批', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'amount_gate', type: 'condition', name: '金额分级判断', config: { branches: [{ edgeKey: 'edge-gate-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 5000 }] }], defaultEdgeKey: 'edge-gate-end' } },
      { key: 'approval_high', type: 'approval', name: '部门主管审批（高额）', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-gate', source: 'approval_1', target: 'amount_gate' },
      { key: 'edge-gate-high', source: 'amount_gate', target: 'approval_high' },
      { key: 'edge-gate-end', source: 'amount_gate', target: 'end' },
      { key: 'edge-high-end', source: 'approval_high', target: 'end' },
    ],
  }
}

// Amount-tier purchase (design-lock #3114): the condition node routes on the top-level `amount` —
// below threshold → a single direct-manager approval; at/above threshold → a PARALLEL fork (joinMode
// 'all' = 会签 by default; 'any' = 或签 editable) joining at `end`. Default threshold 20000.
// The two parallel branches MUST resolve to DISTINCT assignment TYPES: a user-resolving manager
// (manager_at_level → `user:X`) + a static_role (the design's "Configured Role / Person" → `role:Y`).
// The runtime parallel-conflict key is `${assignmentType}:${assigneeId}` (ApprovalProductService.ts
// :4152/4181), so a user-typed and a role-typed branch can NEVER collide — regardless of org data.
// (Two USER-resolving dynamic sources — e.g. an earlier dept_head here alongside manager_at_level —
// CAN resolve to the SAME person at runtime → APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT 409; that
// was the bug.) The role is a STARTER using the APPROVAL_ROLE_CONFIGURE_SENTINEL placeholder: the
// backend FAIL-FASTS at publish (assertNoUnconfiguredPlaceholderRoles → 400 APPROVAL_ROLE_PLACEHOLDER_
// NOT_CONFIGURED) until the admin replaces it with a real role — so an UNTOUCHED preset cannot be
// published at all (a verifiable state, not merely a runtime stuck-flow). The node name signals 发布前配置.
function purchaseAmountTierGraph(): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'budget_owner_approval', type: 'approval', name: '预算负责人审批', config: { assigneeSources: [{ kind: 'form_field_user', fieldId: 'budget_owner' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'amount_gate', type: 'condition', name: '金额分级判断', config: { branches: [{ edgeKey: 'edge-gate-fork', rules: [{ fieldId: 'amount', operator: 'gte', value: 20000 }] }], defaultEdgeKey: 'edge-gate-manager' } },
      { key: 'manager_approval', type: 'approval', name: '直属上级审批', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'parallel_fork', type: 'parallel', name: '高额并行审批（会签）', config: { branches: ['edge-fork-mgr', 'edge-fork-role'], joinMode: 'all', joinNodeKey: 'end' } },
      { key: 'higher_manager_approval', type: 'approval', name: '上级经理审批（高额）', config: { assigneeSources: [{ kind: 'manager_at_level', level: 2 }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'role_approval', type: 'approval', name: '指定审批角色（发布前配置）', config: { assigneeSources: [{ kind: 'static_role', roleIds: [APPROVAL_ROLE_CONFIGURE_SENTINEL] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-budget', source: 'start', target: 'budget_owner_approval' },
      { key: 'edge-budget-gate', source: 'budget_owner_approval', target: 'amount_gate' },
      { key: 'edge-gate-fork', source: 'amount_gate', target: 'parallel_fork' },
      { key: 'edge-gate-manager', source: 'amount_gate', target: 'manager_approval' },
      { key: 'edge-fork-mgr', source: 'parallel_fork', target: 'higher_manager_approval' },
      { key: 'edge-fork-role', source: 'parallel_fork', target: 'role_approval' },
      { key: 'edge-mgr-end', source: 'higher_manager_approval', target: 'end' },
      { key: 'edge-role-end', source: 'role_approval', target: 'end' },
      { key: 'edge-manager-end', source: 'manager_approval', target: 'end' },
    ],
  }
}

function presetConfig(id: CommonApprovalTemplatePresetId): {
  keyPrefix: string
  name: string
  description: string
  category: string
  formSchema: FormSchema
  approvalGraph: ApprovalGraph
} {
  switch (id) {
    case 'leave':
      return {
        keyPrefix: 'leave-approval',
        name: '请假审批',
        description: '常用请假审批草稿。发布前请按组织规则调整审批人。',
        category: '请假',
        formSchema: leaveSchema(),
        approvalGraph: linearGraph([
          { name: '直属上级审批', source: { kind: 'direct_manager' } },
          { name: '部门主管审批', source: { kind: 'dept_head' } },
        ]),
      }
    case 'reimbursement':
      return {
        keyPrefix: 'reimbursement-approval',
        name: '报销审批',
        description: '常用报销审批草稿。发布前请确认费用明细和审批层级。',
        category: '报销',
        formSchema: reimbursementSchema(),
        approvalGraph: linearGraph([
          { name: '直属上级审批', source: { kind: 'direct_manager' } },
          { name: '上两级审批', source: { kind: 'manager_at_level', level: 2 } },
        ]),
      }
    case 'purchase':
      return {
        keyPrefix: 'purchase-approval',
        name: '采购审批',
        description: '常用采购审批草稿。发布前请确认预算负责人和采购明细。',
        category: '采购',
        formSchema: purchaseSchema(),
        approvalGraph: linearGraph([
          { name: '预算负责人审批', source: { kind: 'form_field_user', fieldId: 'budget_owner' } },
          { name: '直属上级审批', source: { kind: 'direct_manager' } },
          { name: '部门主管审批', source: { kind: 'dept_head' } },
        ]),
      }
    case 'reimbursement_amount_tier':
      return {
        keyPrefix: 'reimbursement-amount-tier',
        name: '报销审批（金额分级）',
        description: '高额报销自动升级审批草稿。金额阈值与各级审批人可在编辑页调整后再发布。',
        category: '报销',
        formSchema: withAmountConsistency(reimbursementSchema(), 'amount', 'expense_items', 'amount'),
        approvalGraph: reimbursementAmountTierGraph(),
      }
    case 'purchase_amount_tier':
      return {
        keyPrefix: 'purchase-amount-tier',
        name: '采购审批（金额分级）',
        description: '高额采购升级为并行会签草稿。金额阈值、汇聚模式（会签/或签）与各级审批人可在编辑页调整后再发布。',
        category: '采购',
        formSchema: withAmountConsistency(purchaseSchema(), 'amount', 'purchase_items', 'amount'),
        approvalGraph: purchaseAmountTierGraph(),
      }
  }
}

export function buildCommonApprovalTemplatePresetPayload(
  id: CommonApprovalTemplatePresetId,
  options: BuildCommonApprovalTemplatePresetOptions = {},
): CreateApprovalTemplateRequest {
  const config = presetConfig(id)
  const keySuffix = options.keySuffix ?? nextPresetKeySuffix()
  return {
    key: `${config.keyPrefix}-${keySuffix}`,
    name: config.name,
    description: config.description,
    category: config.category,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    formSchema: config.formSchema,
    approvalGraph: config.approvalGraph,
  }
}
