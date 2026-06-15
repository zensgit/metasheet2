import { describe, expect, it } from 'vitest'
import { resolveLinkFieldProperty } from '../src/multitable/utils/field-config'

// Cross-base FE picker — design-lock 2026-06-14 §3.4 / test-row #1 (wire-vs-fixture).
//
// The picker assembles a link property with `foreignBaseId` (cross-base) or just
// `foreignSheetId` (same-base). The FE normalizer (`resolveLinkFieldProperty`) is the
// read-back path. If it dropped `foreignBaseId`, the picker would emit a cross-base
// field that silently reverts to same-base on reload — the #1781 trap. These tests
// lock the round-trip on the normalizer itself (the wire keystone, no component
// mounting required).
describe('resolveLinkFieldProperty — cross-base foreignBaseId round-trip', () => {
  it('preserves foreignBaseId when both foreignSheetId and foreignBaseId are present (cross-base)', () => {
    const wireProperty = {
      foreignSheetId: 'sheet_foreign',
      foreignDatasheetId: 'sheet_foreign',
      foreignBaseId: 'base_other',
      limitSingleRecord: false,
    }

    const resolved = resolveLinkFieldProperty(wireProperty)

    expect(resolved.foreignSheetId).toBe('sheet_foreign')
    expect(resolved.foreignBaseId).toBe('base_other')
  })

  it('resolves foreignBaseId to null for a same-base link (no foreignBaseId key)', () => {
    const sameBaseProperty = {
      foreignSheetId: 'sheet_2',
      foreignDatasheetId: 'sheet_2',
      limitSingleRecord: true,
    }

    const resolved = resolveLinkFieldProperty(sameBaseProperty)

    expect(resolved.foreignSheetId).toBe('sheet_2')
    expect(resolved.foreignBaseId).toBeNull()
  })

  it('treats a blank/whitespace foreignBaseId as null (mirrors codec trim → omit)', () => {
    expect(resolveLinkFieldProperty({ foreignSheetId: 's', foreignBaseId: '   ' }).foreignBaseId).toBeNull()
    expect(resolveLinkFieldProperty({ foreignSheetId: 's', foreignBaseId: '' }).foreignBaseId).toBeNull()
  })
})
