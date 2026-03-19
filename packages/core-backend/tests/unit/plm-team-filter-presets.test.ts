import { describe, expect, it } from 'vitest'
import {
  buildPlmTeamFilterPresetDuplicateName,
  buildPlmTeamFilterPresetValues,
  mapPlmTeamFilterPresetRow,
  normalizePlmTeamFilterPresetKind,
  normalizePlmTeamFilterPresetState,
} from '../../src/plm/plmTeamFilterPresets'

describe('plmTeamFilterPresets', () => {
  it('normalizes kind and state defensively', () => {
    expect(normalizePlmTeamFilterPresetKind('bom')).toBe('bom')
    expect(normalizePlmTeamFilterPresetKind('where-used')).toBe('where-used')
    expect(normalizePlmTeamFilterPresetKind('other')).toBeNull()

    expect(
      normalizePlmTeamFilterPresetState({
        field: 'path',
        value: 'root/a',
        group: '关键件',
      }),
    ).toEqual({
      field: 'path',
      value: 'root/a',
      group: '关键件',
    })

    expect(normalizePlmTeamFilterPresetState({ value: 'root/b' })).toEqual({
      field: 'all',
      value: 'root/b',
      group: '',
    })
  })

  it('builds storage values and maps rows for the current user', () => {
    const values = buildPlmTeamFilterPresetValues({
      tenantId: 'tenant-a',
      ownerUserId: 'user-a',
      kind: 'bom',
      name: ' 关键 BOM ',
      state: { field: 'path', value: 'root/gear', group: '机械' },
    })

    expect(values).toMatchObject({
      tenant_id: 'tenant-a',
      owner_user_id: 'user-a',
      scope: 'team',
      kind: 'bom',
      name: '关键 BOM',
      name_key: '关键 bom',
    })

    const mapped = mapPlmTeamFilterPresetRow(
      {
        id: 'preset-1',
        tenant_id: 'tenant-a',
        owner_user_id: 'user-a',
        scope: 'team',
        kind: 'bom',
        name: '关键 BOM',
        name_key: '关键 bom',
        is_default: true,
        archived_at: '2026-03-10T08:00:00.000Z',
        state: values.state,
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:10:00.000Z',
      },
      'user-a',
    )

    expect(mapped).toMatchObject({
      id: 'preset-1',
      kind: 'bom',
      scope: 'team',
      name: '关键 BOM',
      ownerUserId: 'user-a',
      canManage: true,
      permissions: {
        canManage: true,
        canApply: false,
        canDuplicate: true,
        canShare: false,
        canDelete: true,
        canArchive: false,
        canRestore: true,
        canRename: false,
        canTransfer: false,
        canSetDefault: false,
        canClearDefault: false,
      },
      isDefault: true,
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
      state: {
        field: 'path',
        value: 'root/gear',
        group: '机械',
      },
    })
  })

  it('builds duplicate names without colliding with existing presets', () => {
    expect(buildPlmTeamFilterPresetDuplicateName('关键 BOM', [])).toBe('关键 BOM（副本）')
    expect(
      buildPlmTeamFilterPresetDuplicateName('关键 BOM', ['关键 BOM（副本）']),
    ).toBe('关键 BOM（副本 2）')
    expect(
      buildPlmTeamFilterPresetDuplicateName(' ', ['团队预设（副本）']),
    ).toBe('团队预设（副本 2）')
  })
})
