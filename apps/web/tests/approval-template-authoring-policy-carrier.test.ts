import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO, RuntimePolicy } from '../src/types/approval'
import {
  buildPublishPolicy,
  createEmptyTemplateDraft,
  draftFromTemplate,
} from '../src/approvals/templateAuthoring'

// L6-P1 (docs/development/approval-lock6-requester-global-policy-20260817.md §1) — the
// policy-carrier defect fix. RuntimePolicy has no draft-side carrier today: the authoring view
// hydrates `allowRevoke` from a hardcoded `true` instead of the persisted value, and publishes
// `{ allowRevoke }` only — REPLACING, not merging, the persisted policy object. Two shipped
// consequences: (1) a template published with `allowRevoke:false` reverts to `true` on the next
// editor republish; (2) any sibling policy field (e.g. `policy.autoApproval`) set through the
// documented publish API is destroyed by the next editor publish. This file pins the fix at the
// pure-function boundary: `draftFromTemplate` (hydrate) and `buildPublishPolicy` (the merge that
// replaces the old inline `{ allowRevoke: draft.value.allowRevoke }` payload).
//
// Gates: P-1 (round-trip — the hydrated value is value-selected, not a constant) and P-2 (no
// policy destruction — an API-set sibling field survives an editor republish unchanged).

const LINEAR_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'approval_1',
      type: 'approval',
      name: '审批人',
      config: { assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'approval_1' },
    { key: 'e2', source: 'approval_1', target: 'end' },
  ],
}

function buildTemplate(policy: RuntimePolicy | null): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1',
    key: 'expense',
    name: '费用审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'published',
    activeVersionId: 'ver_1',
    latestVersionId: 'ver_1',
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T00:00:00Z',
    formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
    approvalGraph: LINEAR_GRAPH,
    policy,
  }
}

describe('L6-P1 draftFromTemplate — hydrate reflects the PERSISTED allowRevoke (gate P-1)', () => {
  it('hydrates allowRevoke:false from a persisted policy (value-selected, not the hardcoded true)', () => {
    const template = buildTemplate({ allowRevoke: false })
    const draft = draftFromTemplate(template)
    expect(draft.allowRevoke).toBe(false)
  })

  // Positive control (P-1 mandatory pairing): the SAME flow with a persisted `true` stays `true` —
  // proves the assertion above is reading the field, not merely never seeing `true` render.
  it('positive control: hydrates allowRevoke:true from a persisted policy', () => {
    const template = buildTemplate({ allowRevoke: true })
    const draft = draftFromTemplate(template)
    expect(draft.allowRevoke).toBe(true)
  })

  it('a never-published template (policy: null) keeps the create-time default of true (no invented default)', () => {
    const template = buildTemplate(null)
    const draft = draftFromTemplate(template)
    expect(draft.allowRevoke).toBe(true)
  })

  it('captures the full persisted policy object verbatim as originalPolicy, including an opaque sibling field', () => {
    const persisted: RuntimePolicy = {
      allowRevoke: false,
      revokeBeforeNodeKeys: ['approval_1'],
      autoApproval: { dedupeHistoricalApprover: true },
    }
    const template = buildTemplate(persisted)
    const draft = draftFromTemplate(template)
    expect(draft.originalPolicy).toEqual(persisted)
  })

  it('a brand-new (never-persisted) draft has no originalPolicy to preserve', () => {
    const draft = createEmptyTemplateDraft()
    expect(draft.originalPolicy).toBeUndefined()
    expect(draft.allowRevoke).toBe(true)
  })
})

describe('L6-P1 buildPublishPolicy — MERGE onto the persisted policy, not a replace (gate P-2)', () => {
  it('preserves an API-set autoApproval sibling field while applying the editor-owned allowRevoke', () => {
    const template = buildTemplate({
      allowRevoke: true,
      autoApproval: { dedupeHistoricalApprover: true },
    })
    const draft = draftFromTemplate(template)
    draft.allowRevoke = false // the ONLY field this editor's control touches
    const published = buildPublishPolicy(draft)
    expect(published).toEqual({
      allowRevoke: false,
      autoApproval: { dedupeHistoricalApprover: true },
    })
  })

  it('preserves revokeBeforeNodeKeys (unexposed in this editor) across a republish', () => {
    const template = buildTemplate({ allowRevoke: true, revokeBeforeNodeKeys: ['approval_1'] })
    const draft = draftFromTemplate(template)
    const published = buildPublishPolicy(draft)
    expect(published.revokeBeforeNodeKeys).toEqual(['approval_1'])
  })

  // Positive control (P-2 mandatory pairing): allowRevoke is the field the editor DOES own, so
  // toggling it in the draft MUST change the published value — preservation above is not achieved
  // by the merge being globally inert.
  it('positive control: allowRevoke itself DOES change when the editor toggles it', () => {
    const template = buildTemplate({ allowRevoke: true, autoApproval: { dedupeHistoricalApprover: true } })
    const draftTrue = draftFromTemplate(template)
    expect(buildPublishPolicy(draftTrue).allowRevoke).toBe(true)

    const draftFalse = draftFromTemplate(template)
    draftFalse.allowRevoke = false
    expect(buildPublishPolicy(draftFalse).allowRevoke).toBe(false)
  })

  it('a brand-new template (no originalPolicy) publishes exactly { allowRevoke } — no field invented', () => {
    const draft = createEmptyTemplateDraft()
    expect(buildPublishPolicy(draft)).toEqual({ allowRevoke: true })
  })
})
