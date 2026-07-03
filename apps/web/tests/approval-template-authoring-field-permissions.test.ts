import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO, NodeFieldPermission } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  setStepFieldPermission,
  stepFieldAccess,
  unsupportedTemplateAuthoringReason,
  validateTemplateDraft,
  type ApprovalStepDraft,
} from '../src/approvals/templateAuthoring'

// T1-4 — LINEAR-editor authoring of node-level field permissions (hidden + readonly). PURE-LOGIC
// tests (no .vue) so they run under approval-web-guard. The GATE: a linear approval node's
// `fieldPermissions` must (a) NOT force the template read-only, (b) round-trip through
// hydrate→build (never flattened), (c) prune entries for deleted fields (backend cross-ref safety),
// (d) omit itself when every field is `editable`, and (e) add NO blocking validation error for a
// hidden routing-driver or a readonly field (non-blocking hint only). Runtime enforcement of
// `hidden` (server echo-redaction) already shipped in #2799 and is covered by the backend suite.

const FIELDS = [
  { id: 'reason', type: 'text' as const, label: '事由', required: true },
  { id: 'secret', type: 'text' as const, label: '机密', required: false },
  { id: 'note', type: 'text' as const, label: '备注', required: false },
  { id: 'approver', type: 'user' as const, label: '审批人', required: false },
]

// Linear start→approval_1→end. `approval_1` hides `secret`, marks `note` readonly, and resolves its
// approver from the `approver` form field (so `approver` is a routing driver).
function linearGraph(fieldPermissions: NodeFieldPermission[]): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        name: '主管',
        config: {
          assigneeSources: [{ kind: 'form_field_user', fieldId: 'approver' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
          fieldPermissions,
        },
      },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

function buildTemplate(approvalGraph: ApprovalGraph): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1', key: 'expense', name: '费用审批', description: null, category: null,
    visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
    activeVersionId: null, latestVersionId: 'ver_1',
    createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
    formSchema: { fields: FIELDS }, approvalGraph,
  }
}

function approvalNodeConfig(graph: ApprovalGraph) {
  const node = graph.nodes.find((candidate) => candidate.key === 'approval_1')
  expect(node).toBeTruthy()
  return node!.config as { fieldPermissions?: NodeFieldPermission[] }
}

describe('T1-4 linear field-permissions authoring', () => {
  it('does NOT lock a linear template with fieldPermissions read-only (fieldPermissions is an allowed linear config key)', () => {
    const template = buildTemplate(linearGraph([{ fieldId: 'secret', access: 'hidden' }]))
    expect(unsupportedTemplateAuthoringReason(template)).toBeNull()
  })

  it('round-trips hidden + readonly fieldPermissions through hydrate→build (never flattened)', () => {
    const template = buildTemplate(linearGraph([
      { fieldId: 'secret', access: 'hidden' },
      { fieldId: 'note', access: 'readonly' },
    ]))
    const draft = draftFromTemplate(template)
    const rebuilt = buildApprovalGraph(draft)
    const config = approvalNodeConfig(rebuilt)
    expect(config.fieldPermissions).toEqual([
      { fieldId: 'secret', access: 'hidden' },
      { fieldId: 'note', access: 'readonly' },
    ])
  })

  it('omits fieldPermissions entirely when every entry is the editable default', () => {
    const template = buildTemplate(linearGraph([{ fieldId: 'secret', access: 'editable' }]))
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(approvalNodeConfig(rebuilt).fieldPermissions).toBeUndefined()
  })

  it('prunes a fieldPermission whose field was deleted (no dangling fieldId → backend cross-ref safe)', () => {
    const template = buildTemplate(linearGraph([{ fieldId: 'secret', access: 'hidden' }]))
    const draft = draftFromTemplate(template)
    // Author deletes the `secret` field.
    draft.fields = draft.fields.filter((field) => field.id !== 'secret')
    const config = approvalNodeConfig(buildApprovalGraph(draft))
    expect(config.fieldPermissions).toBeUndefined()
  })

  it('adds NO blocking validation error for a hidden routing-driver field or a readonly field', () => {
    // `approver` is BOTH the form_field_user routing driver AND hidden; `note` is readonly.
    const template = buildTemplate(linearGraph([
      { fieldId: 'approver', access: 'hidden' },
      { fieldId: 'note', access: 'readonly' },
    ]))
    const draft = draftFromTemplate(template)
    const errors = validateTemplateDraft(draft, unsupportedTemplateAuthoringReason(template))
    expect(errors).toEqual([])
  })

  it('treats a fieldPermission entry with an unknown key as unsupported (fail-closed, never silent flatten)', () => {
    const template = buildTemplate(linearGraph([
      { fieldId: 'secret', access: 'hidden', extra: 'x' } as unknown as NodeFieldPermission,
    ]))
    expect(unsupportedTemplateAuthoringReason(template)).not.toBeNull()
  })

  it('treats a fieldPermission entry with an OUT-OF-ENUM access as unsupported (fail-closed, never silent flatten)', () => {
    // `access: 'bogus'` would pass hydrate's filter-then-drop → silently deleted on save. It must instead
    // fail the linear guard to read-only. (Review P2.)
    const template = buildTemplate(linearGraph([
      { fieldId: 'secret', access: 'bogus' } as unknown as NodeFieldPermission,
    ]))
    expect(unsupportedTemplateAuthoringReason(template)).not.toBeNull()
  })

  it('treats a fieldPermission entry with a NON-STRING fieldId as unsupported (fail-closed)', () => {
    const template = buildTemplate(linearGraph([
      { fieldId: 123, access: 'hidden' } as unknown as NodeFieldPermission,
    ]))
    expect(unsupportedTemplateAuthoringReason(template)).not.toBeNull()
  })

  it('hydrates the step draft with the node fieldPermissions', () => {
    const template = buildTemplate(linearGraph([
      { fieldId: 'secret', access: 'hidden' },
      { fieldId: 'note', access: 'readonly' },
    ]))
    const step = draftFromTemplate(template).steps[0]
    expect(stepFieldAccess(step, 'secret')).toBe('hidden')
    expect(stepFieldAccess(step, 'note')).toBe('readonly')
    expect(stepFieldAccess(step, 'reason')).toBe('editable') // no entry === editable default
  })
})

describe('T1-4 setStepFieldPermission (pure)', () => {
  const base: NodeFieldPermission[] = [{ fieldId: 'secret', access: 'hidden' }]

  it('appends a new non-editable entry', () => {
    expect(setStepFieldPermission(base, 'note', 'readonly')).toEqual([
      { fieldId: 'secret', access: 'hidden' },
      { fieldId: 'note', access: 'readonly' },
    ])
  })

  it('updates an existing entry IN PLACE (position-stable)', () => {
    const perms: NodeFieldPermission[] = [
      { fieldId: 'a', access: 'hidden' },
      { fieldId: 'b', access: 'readonly' },
    ]
    expect(setStepFieldPermission(perms, 'a', 'readonly')).toEqual([
      { fieldId: 'a', access: 'readonly' },
      { fieldId: 'b', access: 'readonly' },
    ])
  })

  it('removes the entry when set back to editable (absent === editable)', () => {
    expect(setStepFieldPermission(base, 'secret', 'editable')).toEqual([])
  })

  it('does not mutate the input array', () => {
    const perms: NodeFieldPermission[] = [{ fieldId: 'secret', access: 'hidden' }]
    setStepFieldPermission(perms, 'note', 'hidden')
    expect(perms).toEqual([{ fieldId: 'secret', access: 'hidden' }])
  })
})

// Type-only guard: the step draft exposes a fieldPermissions array (mirrors the node config).
const _stepShape: Pick<ApprovalStepDraft, 'fieldPermissions'> = { fieldPermissions: [] }
void _stepShape
