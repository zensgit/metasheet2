import { describe, expect, test } from 'vitest'

import { permissionTargetMatchesParts } from '../src/multitable/config-restore'

describe('permissionTargetMatchesParts — permission revert target guard', () => {
  test('accepts partial UPDATE snapshots that omit identity keys', () => {
    expect(permissionTargetMatchesParts('sheet', { accessLevel: 'read' }, ['user', 'u1'])).toBe(true)
    expect(permissionTargetMatchesParts('view', { permission: 'read' }, ['view1', 'user', 'u1'])).toBe(true)
    expect(permissionTargetMatchesParts('field', { visible: true, readOnly: true }, ['field1', 'user', 'u1'])).toBe(true)
  })

  test('rejects explicit identity-key mismatches', () => {
    expect(permissionTargetMatchesParts('sheet', { subjectType: 'user', subjectId: 'u2', accessLevel: 'read' }, ['user', 'u1'])).toBe(false)
    expect(permissionTargetMatchesParts('view', { viewId: 'view2', permission: 'read' }, ['view1', 'user', 'u1'])).toBe(false)
    expect(permissionTargetMatchesParts('field', { fieldId: 'field2', visible: true }, ['field1', 'user', 'u1'])).toBe(false)
  })

  test('accepts explicit matching identity keys', () => {
    expect(permissionTargetMatchesParts('sheet', { subjectType: 'user', subjectId: 'u1', accessLevel: 'read' }, ['user', 'u1'])).toBe(true)
    expect(permissionTargetMatchesParts('view', { viewId: 'view1', subjectType: 'user', subjectId: 'u1', permission: 'read' }, ['view1', 'user', 'u1'])).toBe(true)
    expect(permissionTargetMatchesParts('field', { fieldId: 'field1', subjectType: 'user', subjectId: 'u1', visible: true }, ['field1', 'user', 'u1'])).toBe(true)
  })
})
