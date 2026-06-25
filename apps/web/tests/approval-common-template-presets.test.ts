import { describe, expect, it } from 'vitest'
import type { ApprovalTemplateDetailDTO, CreateApprovalTemplateRequest } from '../src/types/approval'
import {
  buildCommonApprovalTemplatePresetPayload,
  COMMON_APPROVAL_TEMPLATE_PRESETS,
} from '../src/approvals/commonTemplatePresets'
import {
  buildApprovalGraph,
  draftFromTemplate,
  graphReadOnlyReason,
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
  it('ships the basic + amount-tier business presets as draft creators', () => {
    expect(COMMON_APPROVAL_TEMPLATE_PRESETS.map((preset) => preset.id)).toEqual([
      'leave',
      'reimbursement',
      'purchase',
      'reimbursement_amount_tier',
      'purchase_amount_tier',
    ])
  })

  it.each(['leave', 'reimbursement', 'purchase'] as const)(
    '%s basic preset creates a LINEAR editable template payload',
    (presetId) => {
      const payload = buildCommonApprovalTemplatePresetPayload(presetId, { keySuffix: 'unit' })
      const detail = detailFromPayload(payload)
      const nodeTypes = payload.approvalGraph.nodes.map((node) => node.type)

      expect(payload.key).toMatch(new RegExp(`^${presetId}-approval-unit$`))
      expect(nodeTypes.every((type) => type === 'start' || type === 'approval' || type === 'end')).toBe(true)
      expect(payload.approvalGraph.edges).toHaveLength(payload.approvalGraph.nodes.length - 1)
      expect(unsupportedTemplateAuthoringReason(detail)).toBeNull()

      const draft = draftFromTemplate(detail)
      expect(draft.preservedGraph).toBeUndefined()
      expect(draft.steps.length).toBeGreaterThan(0)
      expect(validateTemplateDraft(draft, null)).toEqual([])
    },
  )

  it.each(['reimbursement_amount_tier', 'purchase_amount_tier'] as const)(
    '%s amount-tier preset creates a COMPLEX preserved graph (anti-flatten round-trip, G-1 floor)',
    (presetId) => {
      const payload = buildCommonApprovalTemplatePresetPayload(presetId, { keySuffix: 'unit' })
      const detail = detailFromPayload(payload)
      const nodeTypes = payload.approvalGraph.nodes.map((node) => node.type)

      // complex graph: an `amount` condition gate (+ parallel for purchase). NOT linear.
      expect(nodeTypes).toContain('condition')
      // supported (load-preserved, save ENABLED) but rendered read-only/structured.
      expect(unsupportedTemplateAuthoringReason(detail)).toBeNull()
      expect(graphReadOnlyReason(detail)).not.toBeNull()

      // anti-flatten floor: captured as preservedGraph, NOT projected to steps, and re-emitted
      // byte-identical (load→save can not flatten the condition/parallel nodes).
      const draft = draftFromTemplate(detail)
      expect(draft.preservedGraph).toBeDefined()
      expect(draft.steps).toEqual([])
      expect(buildApprovalGraph(draft)).toEqual(payload.approvalGraph)
      expect(validateTemplateDraft(draft, null)).toEqual([])
    },
  )

  it('reimbursement_amount_tier gates a higher-tier approver on amount >= 5000', () => {
    const payload = buildCommonApprovalTemplatePresetPayload('reimbursement_amount_tier', { keySuffix: 'unit' })
    const gate = payload.approvalGraph.nodes.find((node) => node.type === 'condition')
    expect(gate?.config).toMatchObject({ branches: [{ rules: [{ fieldId: 'amount', operator: 'gte', value: 5000 }] }] })
  })

  it('purchase_amount_tier forks a parallel会签 (join at end) with one user-resolving + one static_role branch — distinct-typed, no dynamic conflict', () => {
    const payload = buildCommonApprovalTemplatePresetPayload('purchase_amount_tier', { keySuffix: 'unit' })
    const graph = payload.approvalGraph
    const parallel = graph.nodes.find((node) => node.type === 'parallel')
    expect(parallel?.config).toMatchObject({ joinMode: 'all', joinNodeKey: 'end' })

    // The two parallel branch approvers must resolve to DISTINCT assignment TYPES — exactly one
    // role-typed (static_role) + one user-resolving — so the runtime parallel-dynamic-conflict (key
    // `assignmentType:assigneeId`) is impossible by construction. The enforcement-layer proof is in
    // approval-wp1-parallel-gateway.api.test.ts (two user branches → 409; user + role → clean fork).
    // This locks the preset SHAPE so it can't regress back to two user-resolving branches.
    const branchKinds = (parallel!.config as { branches: string[] }).branches.map((edgeKey) => {
      const target = graph.edges.find((edge) => edge.key === edgeKey)?.target
      const node = graph.nodes.find((n) => n.key === target)
      return (node?.config as { assigneeSources?: Array<{ kind: string }> }).assigneeSources?.[0]?.kind
    })
    expect(branchKinds.filter((kind) => kind === 'static_role')).toHaveLength(1) // the design's "Configured Role"
    expect(branchKinds.filter((kind) => kind !== 'static_role' && kind !== undefined)).toHaveLength(1) // a user-resolving branch
    expect(branchKinds).not.toContain('dept_head') // the original bug: dept_head(user) + manager_at_level(user) could collide
  })

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

describe('amount-tier presets ship the server-side total-check mapping (#3161)', () => {
  it('purchase_amount_tier carries amountConsistencyCheck → purchase_items.amount', () => {
    const { formSchema } = buildCommonApprovalTemplatePresetPayload('purchase_amount_tier')
    expect(formSchema.amountConsistencyCheck).toEqual({
      totalFieldId: 'amount', detailFieldId: 'purchase_items', amountColumnId: 'amount',
    })
  })
  it('reimbursement_amount_tier carries amountConsistencyCheck → expense_items.amount', () => {
    const { formSchema } = buildCommonApprovalTemplatePresetPayload('reimbursement_amount_tier')
    expect(formSchema.amountConsistencyCheck).toEqual({
      totalFieldId: 'amount', detailFieldId: 'expense_items', amountColumnId: 'amount',
    })
  })
  it('the basic (non-amount-tier) presets do NOT carry the mapping', () => {
    for (const id of ['leave', 'reimbursement', 'purchase'] as const) {
      expect(buildCommonApprovalTemplatePresetPayload(id).formSchema.amountConsistencyCheck).toBeUndefined()
    }
  })
})
