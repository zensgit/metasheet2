import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  CreateApprovalTemplateRequest,
  EmptyAssigneePolicy,
  FormField,
  FormSchema,
} from '../types/approval'

export type CommonApprovalTemplatePresetId = 'leave' | 'reimbursement' | 'purchase'

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
      // Preset v1 does not auto-sum detail rows; admins can keep this as the applicant-entered total.
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
      // Preset v1 does not auto-sum detail rows; admins can keep this as the applicant-entered total.
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
