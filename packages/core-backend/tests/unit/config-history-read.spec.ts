import { describe, test, expect } from 'vitest'

import { configHistoryRequiredCapability } from '../../src/multitable/config-history-read'

// T9-R3 gate口径: read gate = the write gate, per entity type AND per permission subtype.
// FAIL-CLOSED on anything not explicitly mapped.
describe('configHistoryRequiredCapability — T9-R3 gate口径 (fail-closed)', () => {
  test('field → canManageFields', () => {
    expect(configHistoryRequiredCapability('field', 'fld_abc')).toBe('canManageFields')
  })
  test('view → canManageViews', () => {
    expect(configHistoryRequiredCapability('view', 'view_abc')).toBe('canManageViews')
  })
  test('sheet_config → canManageSheetAccess', () => {
    expect(configHistoryRequiredCapability('sheet_config', 'sheet_abc')).toBe('canManageSheetAccess')
  })

  test('permission/sheet → canManageSheetAccess', () => {
    expect(configHistoryRequiredCapability('permission', 'sheet:["role","r1"]')).toBe('canManageSheetAccess')
  })
  test('permission/view → canManageViews (NOT canManageSheetAccess)', () => {
    expect(configHistoryRequiredCapability('permission', 'view:["v1","role","r1"]')).toBe('canManageViews')
  })
  test('permission/field → canManageFields (NOT canManageSheetAccess)', () => {
    expect(configHistoryRequiredCapability('permission', 'field:["f1","role","r1"]')).toBe('canManageFields')
  })

  // ── FAIL CLOSED ──────────────────────────────────────────────────────────
  test('unknown entity_type → null (DENY)', () => {
    expect(configHistoryRequiredCapability('automation', 'x')).toBeNull()
    expect(configHistoryRequiredCapability('record', 'rec_x')).toBeNull()
    expect(configHistoryRequiredCapability('', 'x')).toBeNull()
  })
  test('permission with unknown scope → null (DENY)', () => {
    expect(configHistoryRequiredCapability('permission', 'base:["x"]')).toBeNull()
    expect(configHistoryRequiredCapability('permission', 'record:["x"]')).toBeNull()
  })
  test('permission with malformed / empty entity_id → null (DENY)', () => {
    expect(configHistoryRequiredCapability('permission', '')).toBeNull()
    expect(configHistoryRequiredCapability('permission', 'noscopehere')).toBeNull()
    expect(configHistoryRequiredCapability('permission', ':[]')).toBeNull()
  })
  test('permission with a COLONLESS scope-looking entity_id → null (DENY) — a real `scope:` boundary is required', () => {
    expect(configHistoryRequiredCapability('permission', 'field')).toBeNull()
    expect(configHistoryRequiredCapability('permission', 'view')).toBeNull()
    expect(configHistoryRequiredCapability('permission', 'sheet')).toBeNull()
  })
})
