/**
 * Unit tests for scoped permission derivation — tests the real exported functions.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveFieldPermissions,
  deriveViewPermissions,
  type FieldPermissionScope,
  type ViewPermissionScope,
} from '../../src/multitable/permission-derivation'

describe('deriveViewPermissions', () => {
  const baseCaps = { canRead: true, canManageViews: true }

  it('falls back to global caps when no scope map', () => {
    const result = deriveViewPermissions([{ id: 'v1' }], baseCaps)
    expect(result.v1).toEqual({ canAccess: true, canConfigure: true, canDelete: true })
  })

  it('falls back to global caps when view has no assignments in scope map', () => {
    const scopeMap = new Map<string, ViewPermissionScope>()
    const result = deriveViewPermissions([{ id: 'v1' }], baseCaps, scopeMap)
    expect(result.v1).toEqual({ canAccess: true, canConfigure: true, canDelete: true })
  })

  it('denies access when view has assignments but user has no match (fail-closed)', () => {
    const scopeMap = new Map([
      ['v1', { hasAssignments: true, canRead: false, canWrite: false, canAdmin: false }],
    ])
    const result = deriveViewPermissions([{ id: 'v1' }], baseCaps, scopeMap)
    expect(result.v1.canAccess).toBe(false)
    expect(result.v1.canConfigure).toBe(false)
    expect(result.v1.canDelete).toBe(false)
  })

  it('grants scoped read-only access', () => {
    const scopeMap = new Map([
      ['v1', { hasAssignments: true, canRead: true, canWrite: false, canAdmin: false }],
    ])
    const result = deriveViewPermissions([{ id: 'v1' }], baseCaps, scopeMap)
    expect(result.v1.canAccess).toBe(true)
    expect(result.v1.canConfigure).toBe(false)
    expect(result.v1.canDelete).toBe(false)
  })

  it('grants scoped write access without admin', () => {
    const scopeMap = new Map([
      ['v1', { hasAssignments: true, canRead: true, canWrite: true, canAdmin: false }],
    ])
    const result = deriveViewPermissions([{ id: 'v1' }], baseCaps, scopeMap)
    expect(result.v1.canAccess).toBe(true)
    expect(result.v1.canConfigure).toBe(true)
    expect(result.v1.canDelete).toBe(false)
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

  it('handles mixed views — some scoped, some unscoped', () => {
    const scopeMap = new Map([
      ['v1', { hasAssignments: true, canRead: false, canWrite: false, canAdmin: false }],
    ])
    const result = deriveViewPermissions([{ id: 'v1' }, { id: 'v2' }], baseCaps, scopeMap)
    expect(result.v1.canAccess).toBe(false)
    expect(result.v2.canAccess).toBe(true) // no assignment -> fallback to global
  })
})

describe('deriveFieldPermissions', () => {
  const baseCaps = { canEditRecord: true, canCreateRecord: true }

  it('returns visible+editable for normal fields without scope', () => {
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'string' }],
      baseCaps,
    )
    expect(result.f1).toEqual({ visible: true, readOnly: false })
  })

  it('marks formula fields as always readOnly', () => {
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'formula' }],
      baseCaps,
    )
    expect(result.f1.readOnly).toBe(true)
  })

  it('marks lookup/rollup fields as readOnly', () => {
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'lookup' }, { id: 'f2', type: 'rollup' }],
      baseCaps,
    )
    expect(result.f1.readOnly).toBe(true)
    expect(result.f2.readOnly).toBe(true)
  })

  it('hides fields in hiddenFieldIds', () => {
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'string' }],
      baseCaps,
      { hiddenFieldIds: ['f1'] },
    )
    expect(result.f1.visible).toBe(false)
  })

  it('hides fields with property.hidden=true', () => {
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'string', property: { hidden: true } }],
      baseCaps,
    )
    expect(result.f1.visible).toBe(false)
  })

  it('applies fieldScopeMap visible=false (AND merge)', () => {
    const scopeMap = new Map<string, FieldPermissionScope>([
      ['f1', { visible: false, readOnly: false }],
    ])
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'string' }],
      baseCaps,
      { fieldScopeMap: scopeMap },
    )
    expect(result.f1.visible).toBe(false)
    expect(result.f1.readOnly).toBe(false)
  })

  it('applies fieldScopeMap readOnly=true (OR merge)', () => {
    const scopeMap = new Map<string, FieldPermissionScope>([
      ['f1', { visible: true, readOnly: true }],
    ])
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'string' }],
      baseCaps,
      { fieldScopeMap: scopeMap },
    )
    expect(result.f1.visible).toBe(true)
    expect(result.f1.readOnly).toBe(true)
  })

  it('AND merge: hiddenFieldIds + scope visible=true still hidden', () => {
    const scopeMap = new Map<string, FieldPermissionScope>([
      ['f1', { visible: true, readOnly: false }],
    ])
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'string' }],
      baseCaps,
      { hiddenFieldIds: ['f1'], fieldScopeMap: scopeMap },
    )
    expect(result.f1.visible).toBe(false)
  })

  it('OR merge: formula readOnly + scope readOnly=false still readOnly', () => {
    const scopeMap = new Map<string, FieldPermissionScope>([
      ['f1', { visible: true, readOnly: false }],
    ])
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'formula' }],
      baseCaps,
      { fieldScopeMap: scopeMap },
    )
    expect(result.f1.readOnly).toBe(true)
  })

  it('leaves unscoped fields unchanged when scope map has other fields', () => {
    const scopeMap = new Map<string, FieldPermissionScope>([
      ['f2', { visible: false, readOnly: true }],
    ])
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'string' }, { id: 'f2', type: 'string' }],
      baseCaps,
      { fieldScopeMap: scopeMap },
    )
    expect(result.f1).toEqual({ visible: true, readOnly: false })
    expect(result.f2).toEqual({ visible: false, readOnly: true })
  })

  it('respects allowCreateOnly mode', () => {
    const result = deriveFieldPermissions(
      [{ id: 'f1', type: 'string' }],
      { canEditRecord: false, canCreateRecord: true },
      { allowCreateOnly: true },
    )
    expect(result.f1.readOnly).toBe(false) // canCreateRecord=true in allowCreateOnly mode
  })
})
