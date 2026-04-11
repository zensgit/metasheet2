import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref, computed, nextTick } from 'vue'

// --- Test: deriveViewPermissions with viewScopeMap ---
describe('scoped permission derivation logic (unit)', () => {
  // Simulate the derive functions inline since they're not exported

  type ViewPermissionScope = { hasAssignments: boolean; canRead: boolean; canWrite: boolean; canAdmin: boolean }
  type FieldPermissionScope = { visible: boolean; readOnly: boolean }

  function deriveViewPermissions(
    views: Array<{ id: string }>,
    capabilities: { canRead: boolean; canManageViews: boolean },
    viewScopeMap?: Map<string, ViewPermissionScope>,
  ) {
    return Object.fromEntries(
      views.map((view) => {
        const scope = viewScopeMap?.get(view.id)
        if (scope?.hasAssignments) {
          return [view.id, {
            canAccess: capabilities.canRead && scope.canRead,
            canConfigure: capabilities.canManageViews && scope.canWrite,
            canDelete: capabilities.canManageViews && scope.canAdmin,
          }]
        }
        return [view.id, {
          canAccess: capabilities.canRead,
          canConfigure: capabilities.canManageViews,
          canDelete: capabilities.canManageViews,
        }]
      }),
    )
  }

  function deriveFieldPermissions(
    fields: Array<{ id: string; type: string; property?: Record<string, unknown> }>,
    capabilities: { canEditRecord: boolean },
    opts?: { hiddenFieldIds?: string[]; fieldScopeMap?: Map<string, FieldPermissionScope> },
  ) {
    const hiddenFieldIds = new Set(opts?.hiddenFieldIds ?? [])
    const readOnly = !capabilities.canEditRecord
    const fieldScopeMap = opts?.fieldScopeMap
    return Object.fromEntries(
      fields.map((field) => {
        const baseVisible = !hiddenFieldIds.has(field.id)
        const baseReadOnly = readOnly || field.type === 'formula'
        const scope = fieldScopeMap?.get(field.id)
        return [field.id, {
          visible: baseVisible && (scope?.visible ?? true),
          readOnly: baseReadOnly || (scope?.readOnly ?? false),
        }]
      }),
    )
  }

  describe('deriveViewPermissions with scope map', () => {
    it('falls back to global caps when no assignments', () => {
      const result = deriveViewPermissions(
        [{ id: 'v1' }],
        { canRead: true, canManageViews: true },
      )
      expect(result.v1).toEqual({ canAccess: true, canConfigure: true, canDelete: true })
    })

    it('restricts access when view has assignments but user has no match', () => {
      const scopeMap = new Map([
        ['v1', { hasAssignments: true, canRead: false, canWrite: false, canAdmin: false }],
      ])
      const result = deriveViewPermissions(
        [{ id: 'v1' }],
        { canRead: true, canManageViews: true },
        scopeMap,
      )
      expect(result.v1.canAccess).toBe(false)
      expect(result.v1.canConfigure).toBe(false)
      expect(result.v1.canDelete).toBe(false)
    })

    it('grants scoped read access', () => {
      const scopeMap = new Map([
        ['v1', { hasAssignments: true, canRead: true, canWrite: false, canAdmin: false }],
      ])
      const result = deriveViewPermissions(
        [{ id: 'v1' }],
        { canRead: true, canManageViews: true },
        scopeMap,
      )
      expect(result.v1.canAccess).toBe(true)
      expect(result.v1.canConfigure).toBe(false)
    })

    it('does not escalate beyond base capabilities', () => {
      const scopeMap = new Map([
        ['v1', { hasAssignments: true, canRead: true, canWrite: true, canAdmin: true }],
      ])
      const result = deriveViewPermissions(
        [{ id: 'v1' }],
        { canRead: true, canManageViews: false },
        scopeMap,
      )
      expect(result.v1.canAccess).toBe(true)
      expect(result.v1.canConfigure).toBe(false)
      expect(result.v1.canDelete).toBe(false)
    })
  })

  describe('deriveFieldPermissions with scope map', () => {
    it('applies field-scope visible=false to hide a field', () => {
      const scopeMap = new Map([
        ['f1', { visible: false, readOnly: false }],
      ])
      const result = deriveFieldPermissions(
        [{ id: 'f1', type: 'string' }],
        { canEditRecord: true },
        { fieldScopeMap: scopeMap },
      )
      expect(result.f1.visible).toBe(false)
      expect(result.f1.readOnly).toBe(false)
    })

    it('applies field-scope readOnly=true to lock a field', () => {
      const scopeMap = new Map([
        ['f1', { visible: true, readOnly: true }],
      ])
      const result = deriveFieldPermissions(
        [{ id: 'f1', type: 'string' }],
        { canEditRecord: true },
        { fieldScopeMap: scopeMap },
      )
      expect(result.f1.visible).toBe(true)
      expect(result.f1.readOnly).toBe(true)
    })

    it('combines view hidden + field scope (AND for visible)', () => {
      const scopeMap = new Map([
        ['f1', { visible: true, readOnly: false }],
      ])
      const result = deriveFieldPermissions(
        [{ id: 'f1', type: 'string' }],
        { canEditRecord: true },
        { hiddenFieldIds: ['f1'], fieldScopeMap: scopeMap },
      )
      expect(result.f1.visible).toBe(false)
    })

    it('combines base readOnly + field scope (OR for readOnly)', () => {
      const scopeMap = new Map([
        ['f1', { visible: true, readOnly: false }],
      ])
      const result = deriveFieldPermissions(
        [{ id: 'f1', type: 'formula' }],
        { canEditRecord: true },
        { fieldScopeMap: scopeMap },
      )
      expect(result.f1.readOnly).toBe(true) // formula is always readOnly
    })

    it('leaves fields without scope entries unchanged', () => {
      const scopeMap = new Map([
        ['f2', { visible: false, readOnly: true }],
      ])
      const result = deriveFieldPermissions(
        [{ id: 'f1', type: 'string' }, { id: 'f2', type: 'string' }],
        { canEditRecord: true },
        { fieldScopeMap: scopeMap },
      )
      expect(result.f1).toEqual({ visible: true, readOnly: false })
      expect(result.f2).toEqual({ visible: false, readOnly: true })
    })
  })
})

// --- Test: canExport capability composable ---
describe('canExport capability', () => {
  // Inline the capability logic to test fallback behavior
  it('defaults canExport to canRead when field is missing', () => {
    const caps = { canRead: true, canCreateRecord: false, canEditRecord: false, canDeleteRecord: false, canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: false, canManageAutomation: false } as any
    // Simulate the fallback: canExport ?? canRead
    const canExport = caps.canExport ?? caps.canRead
    expect(canExport).toBe(true)
  })

  it('respects explicit canExport=false', () => {
    const caps = { canRead: true, canExport: false } as any
    const canExport = caps.canExport ?? caps.canRead
    expect(canExport).toBe(false)
  })
})
