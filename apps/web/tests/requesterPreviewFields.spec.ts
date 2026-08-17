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

  // Lock-8 L8-B (OD-L8-5(a)) regression: `rule.fieldId` may be a dotted date_range endpoint
  // address (`${id}.start`/`${id}.end`). `visibleIds` only ever holds BASE field ids — no field
  // literally has a dotted id — so BEFORE this fix `visibleIds.has(rule.fieldId)` was unconditionally
  // false for a dotted address, which misreported EVERY endpoint-dependent field as "hidden because
  // its dependency is hidden" even when the base date_range field was plainly visible, and the
  // fallback `labelOf` lookup leaked the raw `trip.start` internal address into requester-facing copy.
  it('date_range endpoint dependency: a field hidden by its OWN rule is described by that rule, not misreported as chain-hidden, when the base date_range field is visible', () => {
    const s = schema([
      { id: 'trip', type: 'date_range', label: '行程日期' },
      { id: 'reason', type: 'text', label: '说明', visibilityRule: { fieldId: 'trip.start', operator: 'notEmpty' } },
    ] as FormSchema['fields'])
    // `trip` carries no rule of its own -> always visible. `reason`'s own rule (trip.start
    // notEmpty) fails because the sample's start endpoint is blank -> reason is hidden, but NOT
    // via the chain (its dependency, trip, is visible).
    const r = computeRequesterPreviewFields(s, { trip: { start: '', end: '' } })
    expect(r.visible.map((f) => f.id)).toEqual(['trip'])
    expect(r.hidden).toHaveLength(1)
    expect(r.hidden[0]!.field.id).toBe('reason')
    // Must come from describeFieldVisibilityRule (its own rule), never the chain-hidden template —
    // and must never leak the raw dotted address.
    expect(r.hidden[0]!.reason).not.toContain('依赖的字段')
    expect(r.hidden[0]!.reason).not.toContain('trip.start')
    expect(r.hidden[0]!.reason).toContain('行程日期(起始)')
    expect(r.hidden[0]!.reason).toContain('不为空时显示')
  })

  it('date_range endpoint dependency: a satisfied endpoint rule keeps the dependent field visible', () => {
    const s = schema([
      { id: 'trip', type: 'date_range', label: '行程日期' },
      { id: 'reason', type: 'text', label: '说明', visibilityRule: { fieldId: 'trip.start', operator: 'notEmpty' } },
    ] as FormSchema['fields'])
    const r = computeRequesterPreviewFields(s, { trip: { start: '2026-01-01', end: '2026-01-05' } })
    expect(r.visible.map((f) => f.id)).toEqual(['trip', 'reason'])
    expect(r.hidden).toEqual([])
  })
})
