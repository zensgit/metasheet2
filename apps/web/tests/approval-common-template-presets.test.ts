import { describe, expect, it } from 'vitest'
import type { ApprovalTemplateDetailDTO, CreateApprovalTemplateRequest } from '../src/types/approval'
import {
  buildCommonApprovalTemplatePresetPayload,
  COMMON_APPROVAL_TEMPLATE_PRESETS,
  type CommonApprovalTemplatePresetId,
} from '../src/approvals/commonTemplatePresets'
import {
  draftFromTemplate,
  unsupportedTemplateAuthoringReason,
  validateTemplateDraft,
} from '../src/approvals/templateAuthoring'

function detailFromPayload(payload: CreateApprovalTemplateRequest): ApprovalTemplateDetailDTO {
  return {
    id: `tpl_${payload.key}`,
    key: payload.key,
    name: payload.name,
    description: payload.description ?? null,
    category: payload.category ?? null,
    visibilityScope: payload.visibilityScope ?? { type: 'all', ids: [] },
    slaHours: payload.slaHours ?? null,
    status: 'draft',
    activeVersionId: null,
    latestVersionId: 'ver_1',
    createdAt: '2026-06-23T00:00:00Z',
    updatedAt: '2026-06-23T00:00:00Z',
    formSchema: payload.formSchema,
    approvalGraph: payload.approvalGraph,
  }
}

describe('common approval template presets', () => {
  it('ships the first three business presets as draft creators', () => {
    expect(COMMON_APPROVAL_TEMPLATE_PRESETS.map((preset) => preset.id)).toEqual([
      'leave',
      'reimbursement',
      'purchase',
    ])
  })

  it.each(COMMON_APPROVAL_TEMPLATE_PRESETS.map((preset) => preset.id))(
    '%s preset creates a linear editable template payload',
    (presetId) => {
      const payload = buildCommonApprovalTemplatePresetPayload(presetId as CommonApprovalTemplatePresetId, {
        keySuffix: 'unit',
      })
      const detail = detailFromPayload(payload)
      const nodeTypes = payload.approvalGraph.nodes.map((node) => node.type)

      expect(payload.key).toMatch(new RegExp(`^${presetId === 'leave' ? 'leave' : presetId}-approval-unit$`))
      expect(nodeTypes.every((type) => type === 'start' || type === 'approval' || type === 'end')).toBe(true)
      expect(payload.approvalGraph.edges).toHaveLength(payload.approvalGraph.nodes.length - 1)
      expect(unsupportedTemplateAuthoringReason(detail)).toBeNull()

      const draft = draftFromTemplate(detail)
      expect(draft.preservedGraph).toBeUndefined()
      expect(draft.steps.length).toBeGreaterThan(0)
      expect(validateTemplateDraft(draft, null)).toEqual([])
    },
  )

  it('purchase preset uses the budget owner user field and a detail table without complex graph nodes', () => {
    const payload = buildCommonApprovalTemplatePresetPayload('purchase', { keySuffix: 'unit' })
    const budgetOwner = payload.formSchema.fields.find((field) => field.id === 'budget_owner')
    const detail = payload.formSchema.fields.find((field) => field.id === 'purchase_items')
    const approvalSources = payload.approvalGraph.nodes
      .filter((node) => node.type === 'approval')
      .map((node) => node.config)

    expect(budgetOwner?.type).toBe('user')
    expect(detail?.type).toBe('detail')
    expect(detail?.columns?.map((field) => field.id)).toEqual([
      'name',
      'spec',
      'quantity',
      'unit_price',
      'amount',
      'note',
    ])
    expect(approvalSources[0]).toMatchObject({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'budget_owner' }],
    })
  })
})
