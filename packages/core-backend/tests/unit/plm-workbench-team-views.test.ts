import { describe, expect, it } from 'vitest'
import {
  buildPlmWorkbenchTeamViewDuplicateName,
  buildPlmWorkbenchTeamViewValues,
  mapPlmWorkbenchTeamViewRow,
  normalizePlmWorkbenchTeamViewDefaultFlag,
  normalizePlmWorkbenchTeamViewKind,
  normalizePlmWorkbenchTeamViewState,
} from '../../src/plm/plmWorkbenchTeamViews'

describe('plmWorkbenchTeamViews helpers', () => {
  it('normalizes kind and arbitrary json state defensively', () => {
    expect(normalizePlmWorkbenchTeamViewKind('documents')).toBe('documents')
    expect(normalizePlmWorkbenchTeamViewKind('cad')).toBe('cad')
    expect(normalizePlmWorkbenchTeamViewKind('approvals')).toBe('approvals')
    expect(normalizePlmWorkbenchTeamViewKind('workbench')).toBe('workbench')
    expect(normalizePlmWorkbenchTeamViewKind('other')).toBeNull()

    expect(
      normalizePlmWorkbenchTeamViewState({
        columns: ['name', 'revision'],
        filters: {
          owner: 'team-a',
        },
        nested: [1, true, null, { panel: 'cad' }],
      }),
    ).toEqual({
      columns: ['name', 'revision'],
      filters: {
        owner: 'team-a',
      },
      nested: [1, true, null, { panel: 'cad' }],
    })

    expect(normalizePlmWorkbenchTeamViewState('raw-string-state')).toBe('raw-string-state')
    expect(normalizePlmWorkbenchTeamViewState(undefined)).toEqual({})
  })

  it('builds stored values and preserves is_default', () => {
    const values = buildPlmWorkbenchTeamViewValues({
      tenantId: 'tenant-a',
      ownerUserId: 'user-a',
      kind: 'documents',
      name: ' 文档总览 ',
      isDefault: true,
      state: {
        columns: ['name', 'fileId'],
        sorts: [{ field: 'updated_at', dir: 'desc' }],
      },
    })

    expect(values).toMatchObject({
      tenant_id: 'tenant-a',
      owner_user_id: 'user-a',
      scope: 'team',
      kind: 'documents',
      name: '文档总览',
      name_key: '文档总览',
      is_default: true,
    })
    expect(values.state).toContain('"columns":["name","fileId"]')
  })

  it('maps stored rows and default flags for the current user', () => {
    const mapped = mapPlmWorkbenchTeamViewRow(
      {
        id: 'view-1',
        tenant_id: 'tenant-a',
        owner_user_id: 'user-a',
        scope: 'team',
        kind: 'cad',
        name: 'CAD 审核',
        name_key: 'cad 审核',
        is_default: 'true',
        last_default_set_at: '2026-03-09T00:15:00.000Z',
        state: JSON.stringify({
          panel: 'cad',
          compare: ['primary', 'other'],
        }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:10:00.000Z',
      },
      'user-a',
    )

    expect(mapped).toMatchObject({
      id: 'view-1',
      kind: 'cad',
      scope: 'team',
      name: 'CAD 审核',
      ownerUserId: 'user-a',
      canManage: true,
      permissions: {
        canManage: true,
        canApply: true,
        canDuplicate: true,
        canShare: true,
        canDelete: true,
        canArchive: true,
        canRestore: false,
        canRename: true,
        canTransfer: true,
        canSetDefault: false,
        canClearDefault: true,
      },
      isDefault: true,
      lastDefaultSetAt: '2026-03-09T00:15:00.000Z',
      state: {
        panel: 'cad',
        compare: ['primary', 'other'],
      },
    })
  })

  it('marks archived rows with archived metadata', () => {
    const mapped = mapPlmWorkbenchTeamViewRow(
      {
        id: 'view-archived',
        tenant_id: 'tenant-a',
        owner_user_id: 'user-a',
        scope: 'team',
        kind: 'workbench',
        name: '已归档工作台',
        name_key: '已归档工作台',
        is_default: false,
        state: JSON.stringify({
          query: {
            documentFilter: 'archived',
          },
        }),
        archived_at: '2026-03-10T08:00:00.000Z',
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-10T08:00:00.000Z',
      },
      'user-a',
    )

    expect(mapped).toMatchObject({
      id: 'view-archived',
      kind: 'workbench',
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
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
      state: {
        query: {
          documentFilter: 'archived',
        },
      },
    })
  })

  it('preserves workbench query snapshots', () => {
    const values = buildPlmWorkbenchTeamViewValues({
      tenantId: 'tenant-a',
      ownerUserId: 'user-a',
      kind: 'workbench',
      name: 'PLM 工作台',
      state: {
        query: {
          productId: 'prod-100',
          documentFilter: 'gear',
          approvalsFilter: 'eco',
          autoload: 'true',
        },
      },
    })

    expect(values.kind).toBe('workbench')
    expect(values.state).toContain('"productId":"prod-100"')

    const mapped = mapPlmWorkbenchTeamViewRow(
      {
        id: 'view-workbench',
        tenant_id: 'tenant-a',
        owner_user_id: 'user-a',
        scope: 'team',
        kind: 'workbench',
        name: 'PLM 工作台',
        name_key: 'plm 工作台',
        is_default: false,
        state: JSON.stringify({
          query: {
            productId: 'prod-100',
            documentFilter: 'gear',
            approvalsFilter: 'eco',
            autoload: 'true',
          },
        }),
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:10:00.000Z',
      },
      'user-a',
    )

    expect(mapped).toMatchObject({
      kind: 'workbench',
      state: {
        query: {
          productId: 'prod-100',
          documentFilter: 'gear',
          approvalsFilter: 'eco',
          autoload: 'true',
        },
      },
    })
  })

  it('reads default flags from mixed input forms', () => {
    expect(normalizePlmWorkbenchTeamViewDefaultFlag(true)).toBe(true)
    expect(normalizePlmWorkbenchTeamViewDefaultFlag('1')).toBe(true)
    expect(normalizePlmWorkbenchTeamViewDefaultFlag('false')).toBe(false)
    expect(normalizePlmWorkbenchTeamViewDefaultFlag(0)).toBe(false)
  })

  it('builds stable duplicate names without colliding with existing copies', () => {
    expect(buildPlmWorkbenchTeamViewDuplicateName('PLM 工作台', [])).toBe('PLM 工作台（副本）')
    expect(
      buildPlmWorkbenchTeamViewDuplicateName('PLM 工作台', [
        'PLM 工作台',
        'PLM 工作台（副本）',
        'PLM 工作台（副本 2）',
      ]),
    ).toBe('PLM 工作台（副本 3）')
  })
})
