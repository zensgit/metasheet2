import { describe, expect, it } from 'vitest'

import { computeRequesterPreviewFields } from '../src/approvals/requesterPreviewFields'
import type { FormSchema } from '../src/types/approval'

// G-B2-21 — the authoring panel's requester-view split. Visibility is delegated to
// getVisibleFormFields (shared with ApprovalNewView + the backend prune), so these cases pin the
// SPLIT + reason behavior, not a re-implementation of the rule engine.

function schema(fields: FormSchema['fields']): FormSchema {
  return { fields } as FormSchema
}

describe('computeRequesterPreviewFields', () => {
  it('empty / null schema → empty split', () => {
    expect(computeRequesterPreviewFields(null, {})).toEqual({ visible: [], hidden: [] })
    expect(computeRequesterPreviewFields(schema([]), {})).toEqual({ visible: [], hidden: [] })
  })

  it('no visibility rules → every field visible, none hidden', () => {
    const s = schema([
      { id: 'a', type: 'text', label: '事由' },
      { id: 'b', type: 'number', label: '金额' },
    ] as FormSchema['fields'])
    const r = computeRequesterPreviewFields(s, {})
    expect(r.visible.map((f) => f.id)).toEqual(['a', 'b'])
    expect(r.hidden).toEqual([])
  })

  it('a rule that matches → the field is visible', () => {
    const s = schema([
      { id: 'kind', type: 'select', label: '类型' },
      { id: 'reason', type: 'text', label: '说明', visibilityRule: { fieldId: 'kind', operator: 'eq', value: 'other' } },
    ] as FormSchema['fields'])
    const r = computeRequesterPreviewFields(s, { kind: 'other' })
    expect(r.visible.map((f) => f.id)).toEqual(['kind', 'reason'])
    expect(r.hidden).toEqual([])
  })

  it('a rule that does not match → the field is hidden WITH a reason', () => {
    const s = schema([
      { id: 'kind', type: 'select', label: '类型' },
      { id: 'reason', type: 'text', label: '说明', visibilityRule: { fieldId: 'kind', operator: 'eq', value: 'other' } },
    ] as FormSchema['fields'])
    const r = computeRequesterPreviewFields(s, { kind: 'normal' })
    expect(r.visible.map((f) => f.id)).toEqual(['kind'])
    expect(r.hidden).toHaveLength(1)
    expect(r.hidden[0]!.field.id).toBe('reason')
    expect(r.hidden[0]!.reason).toContain('类型') // dependency label
    expect(r.hidden[0]!.reason).toContain('显示')
  })

  it('dependency chain: hiding A also hides B that depends on A, and B gets the chain reason', () => {
    const s = schema([
      { id: 'kind', type: 'select', label: '类型' },
      { id: 'a', type: 'text', label: 'A', visibilityRule: { fieldId: 'kind', operator: 'eq', value: 'special' } },
      { id: 'b', type: 'text', label: 'B', visibilityRule: { fieldId: 'a', operator: 'notEmpty' } },
    ] as FormSchema['fields'])
    // kind !== special → a hidden → b's dependency (a) is hidden → b hidden too
    const r = computeRequesterPreviewFields(s, { kind: 'normal', a: 'filled' })
    expect(r.visible.map((f) => f.id)).toEqual(['kind'])
    const hiddenIds = r.hidden.map((h) => h.field.id)
    expect(hiddenIds).toEqual(['a', 'b'])
    // `b`'s own rule (notEmpty a) is SATISFIED, so it must NOT be described by its own rule — it's
    // hidden via the chain, and the reason names the hidden dependency `A`.
    const bReason = r.hidden.find((h) => h.field.id === 'b')!.reason
    expect(bReason).toContain('依赖的字段')
    expect(bReason).toContain('A')
    expect(bReason).not.toContain('不为空时显示')
    // `a`'s reason IS its own rule (its dependency `kind` is visible; a's own eq rule failed).
    expect(r.hidden.find((h) => h.field.id === 'a')!.reason).toContain('special')
  })

  it('sample values flip visibility live (same input, different sample → different split)', () => {
    const s = schema([
      { id: 'kind', type: 'select', label: '类型' },
      { id: 'reason', type: 'text', label: '说明', visibilityRule: { fieldId: 'kind', operator: 'eq', value: 'other' } },
    ] as FormSchema['fields'])
    expect(computeRequesterPreviewFields(s, { kind: 'other' }).hidden).toHaveLength(0)
    expect(computeRequesterPreviewFields(s, { kind: 'x' }).hidden).toHaveLength(1)
  })
})
