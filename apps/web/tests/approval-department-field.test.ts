import { describe, expect, it } from 'vitest'
import { buildDisplayFields } from '../src/approvals/detailField'
import { approvalFormulaInsertOptions, validateConditionEdits } from '../src/approvals/conditionEdit'
import { prefillFromSnapshot } from '../src/approvals/prefillFromSnapshot'
import {
  AUTHORABLE_FIELD_TYPES,
  DETAIL_LEAF_FIELD_TYPES,
  buildFormSchema,
  createEmptyFieldDraft,
  createEmptyTemplateDraft,
  draftFromTemplate,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import type { ApprovalTemplateDetailDTO, FormField } from '../src/types/approval'

function buildTemplate(field: FormField): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl-department',
    key: 'department',
    name: '部门审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'draft',
    activeVersionId: null,
    latestVersionId: 'ver-department',
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    formSchema: { fields: [field] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'start-approval', source: 'start', target: 'approval' },
        { key: 'approval-end', source: 'approval', target: 'end' },
      ],
    },
  }
}

describe('Lock-2 L2-A department authoring contract', () => {
  it('registers department as authorable but never as a detail leaf', () => {
    expect(AUTHORABLE_FIELD_TYPES).toContain('department')
    expect(DETAIL_LEAF_FIELD_TYPES).not.toContain('department')
  })

  it('builds the exact typed props and hydrates them without coercing malformed values', () => {
    const draft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'department',
        type: 'department',
        label: '归属部门',
        departmentSelection: 'multi',
        departmentDisplay: 'full_path',
        departmentDefaultMode: 'designated',
        departmentDefaultIds: ['dept-a', 'dept-b'],
        departmentMaxSelectionsText: '3',
      }],
    }
    expect(buildFormSchema(draft).fields[0].props).toEqual({
      selection: 'multi',
      display: 'full_path',
      defaultMode: 'designated',
      defaultDepartmentIds: ['dept-a', 'dept-b'],
      maxSelections: 3,
    })

    const hydrated = draftFromTemplate(buildTemplate({
      id: 'department',
      type: 'department',
      label: '归属部门',
      props: {
        selection: 'multi',
        display: 'full_path',
        defaultMode: 'designated',
        defaultDepartmentIds: ['dept-a', 7, ''],
        maxSelections: 3,
      },
    }))
    expect(hydrated.fields[0]).toMatchObject({
      departmentSelection: 'multi',
      departmentDisplay: 'full_path',
      departmentDefaultMode: 'designated',
      departmentDefaultIds: ['dept-a'],
      departmentMaxSelectionsText: '3',
    })
  })

  it('drops all department props after a cross-type retype', () => {
    const original: FormField = {
      id: 'department',
      type: 'department',
      label: '归属部门',
      props: {
        selection: 'multi',
        display: 'full_path',
        defaultMode: 'designated',
        defaultDepartmentIds: ['dept-secret'],
        maxSelections: 4,
      },
    }
    const draft: TemplateAuthoringDraft = {
      ...createEmptyTemplateDraft(),
      fields: [{
        ...createEmptyFieldDraft(1),
        id: 'department',
        type: 'text',
        label: '普通文本',
        original,
      }],
    }
    expect(buildFormSchema(draft).fields[0].props).toBeUndefined()
  })

  it('does not strip same-name props from an unchanged user field', () => {
    const original: FormField = {
      id: 'contact',
      type: 'user',
      label: '联系人',
      props: {
        allowSelf: true,
        selection: 'multi',
        defaultMode: 'designated',
        defaultUserIds: ['user-a'],
      },
    }
    const draft = draftFromTemplate(buildTemplate(original))
    expect(buildFormSchema(draft).fields[0].props).toEqual(original.props)
  })

  it('does not offer department formula tokens and rejects rule/formula dependencies before publish', () => {
    const formSchema = {
      fields: [
        { id: 'amount', type: 'number', label: '金额' },
        { id: 'department', type: 'department', label: '部门', props: { selection: 'single', display: 'full_path' } },
      ],
    } as const
    expect(approvalFormulaInsertOptions(formSchema)).toEqual([{ token: '{amount}', label: '金额' }])

    const base = {
      nodeKey: 'cond_1',
      defaultEdgeKey: '',
    }
    expect(validateConditionEdits({
      cond_1: {
        ...base,
        branches: [{
          edgeKey: 'e1',
          predicateMode: 'rules',
          conjunction: 'and',
          rules: [{ fieldId: 'department', operator: 'notEmpty', value: undefined }],
          formulaExpression: '',
        }],
      },
    }, formSchema)).toContain('条件节点 cond_1 分支 1 规则 1 不能引用部门字段（v1）')
    expect(validateConditionEdits({
      cond_1: {
        ...base,
        branches: [{
          edgeKey: 'e1',
          predicateMode: 'formula',
          conjunction: 'and',
          rules: [],
          formulaExpression: '{department} != ""',
        }],
      },
    }, formSchema)).toContain('条件节点 cond_1 分支 1 公式 不能引用部门字段 department（v1）')
  })
})

describe('Lock-2 L2-A frozen value contract', () => {
  const field: FormField = {
    id: 'department',
    type: 'department',
    label: '归属部门',
    props: { selection: 'multi', display: 'full_path' },
  }

  it('renders only frozen server names/paths and never falls back to ids', () => {
    const display = buildDisplayFields(
      { fields: [field] },
      {
        department: [
          { id: 'dept-secret-a', name: '产品部', fullPath: '总部 / 产品部' },
          { id: 'dept-secret-b', name: '', fullPath: '' },
        ],
      },
    )
    expect(display).toEqual([{ key: 'department', label: '归属部门', value: '总部 / 产品部' }])
    expect(JSON.stringify(display)).not.toContain('dept-secret')
  })

  it('resubmit prefill strips frozen labels and emits only exact {id} values', () => {
    expect(prefillFromSnapshot(
      { fields: [field] },
      { department: [{ id: 'dept-a', name: '产品部', fullPath: '总部 / 产品部', injected: true }] },
    )).toEqual({ department: [{ id: 'dept-a' }] })
  })
})
