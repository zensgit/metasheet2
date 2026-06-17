import { describe, it, expect } from 'vitest'
import { projectFormContextView } from '../../src/multitable/form-context-view-projection'

describe('#2730 projectFormContextView — form-context view echo must not leak view.config', () => {
  const fullView = {
    id: 'view_1',
    sheetId: 'sheet_1',
    name: 'Intake form',
    type: 'form',
    filterInfo: { conditions: [{ fieldId: 'f1', operator: 'eq', value: 'x' }] },
    sortInfo: { rules: [] },
    groupInfo: { rules: [] },
    hiddenFieldIds: ['f9'],
    config: {
      parentFieldId: 'f2',
      frozenLeftColumnIds: ['f3'],
      formLayout: { pages: [], redirect: { url: 'https://example.com' } },
      publicForm: {
        enabled: true,
        publicToken: 'SECRET_TOKEN_abc123',
        allowedUserIds: ['user_secret_1', 'user_secret_2'],
        allowedMemberGroupIds: ['grp_secret_1'],
        accessMode: 'dingtalk',
      },
    },
  }

  it('DROPS config entirely (no publicForm token / allowlists / any config key survives)', () => {
    const projected = projectFormContextView(fullView)
    expect('config' in projected).toBe(false)
    // Belt-and-suspenders: the serialized projection contains none of the secrets.
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('SECRET_TOKEN_abc123')
    expect(serialized).not.toContain('user_secret_1')
    expect(serialized).not.toContain('grp_secret_1')
    expect(serialized).not.toContain('publicForm')
    // Forward-safe: even a hypothetical future config secret is gone (whole config dropped).
    expect(serialized).not.toContain('frozenLeftColumnIds')
    expect(serialized).not.toContain('formLayout')
  })

  it('KEEPS the presentational top-level keys the form-context render needs', () => {
    const projected = projectFormContextView(fullView)
    expect(projected).toEqual({
      id: 'view_1',
      sheetId: 'sheet_1',
      name: 'Intake form',
      type: 'form',
      filterInfo: { conditions: [{ fieldId: 'f1', operator: 'eq', value: 'x' }] },
      sortInfo: { rules: [] },
      groupInfo: { rules: [] },
      hiddenFieldIds: ['f9'],
    })
  })

  it('is a no-op shape when there is no config (idempotent on already-safe views)', () => {
    const noConfig = { id: 'v', sheetId: 's', name: 'n', type: 'grid' }
    expect(projectFormContextView(noConfig)).toEqual(noConfig)
  })
})
