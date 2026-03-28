import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archivePlmWorkbenchTeamView,
  archivePlmTeamFilterPreset,
  batchPlmWorkbenchTeamViews,
  batchPlmTeamFilterPresets,
  exportPlmCollaborativeAuditLogsCsv,
  getPlmCollaborativeAuditSummary,
  restorePlmWorkbenchTeamView,
  restorePlmTeamFilterPreset,
  clearPlmWorkbenchTeamViewDefault,
  clearPlmTeamFilterPresetDefault,
  duplicatePlmWorkbenchTeamView,
  duplicatePlmTeamFilterPreset,
  deletePlmWorkbenchTeamView,
  deletePlmTeamFilterPreset,
  listPlmCollaborativeAuditLogs,
  listPlmWorkbenchTeamViews,
  listPlmTeamFilterPresets,
  renamePlmWorkbenchTeamView,
  renamePlmTeamFilterPreset,
  savePlmWorkbenchTeamView,
  savePlmTeamFilterPreset,
  setPlmWorkbenchTeamViewDefault,
  setPlmTeamFilterPresetDefault,
  transferPlmTeamFilterPreset,
  transferPlmWorkbenchTeamView,
} from '../src/services/plm/plmWorkbenchClient'

describe('plmWorkbenchClient', () => {
  const fetchMock = vi.fn()

  function getRequestHeaders(callIndex: number): Headers {
    const options = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined
    return new Headers(options?.headers)
  }

  function expectAuthHeader(callIndex: number): void {
    expect(getRequestHeaders(callIndex).get('authorization')).toBe('Bearer test-token')
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    localStorage.clear()
    localStorage.setItem('auth_token', 'test-token')
  })

  it('lists team presets by kind', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'preset-1',
            kind: 'bom',
            name: '关键 BOM',
            ownerUserId: 'dev-user',
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
            lastDefaultSetAt: '2026-03-28T09:00:00.000Z',
            state: { field: 'path', value: 'root/a', group: '机械' },
          },
        ],
        metadata: {
          total: 3,
          activeTotal: 2,
          archivedTotal: 1,
          tenantId: 'tenant-a',
          kind: 'bom',
          defaultPresetId: 'preset-1',
        },
      }),
    })

    const result = await listPlmTeamFilterPresets('bom')

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/filter-presets/team?kind=bom'),
      expect.any(Object),
    )
    expectAuthHeader(0)
    expect(result.items[0]).toMatchObject({
      id: 'preset-1',
      kind: 'bom',
      name: '关键 BOM',
      permissions: {
        canManage: true,
        canSetDefault: false,
        canClearDefault: true,
      },
      isDefault: true,
      lastDefaultSetAt: '2026-03-28T09:00:00.000Z',
      state: { field: 'path', value: 'root/a', group: '机械' },
    })
    expect(result.metadata).toEqual({
      total: 3,
      activeTotal: 2,
      archivedTotal: 1,
      tenantId: 'tenant-a',
      kind: 'bom',
      defaultPresetId: 'preset-1',
    })
  })

  it('saves, toggles default, and deletes team presets', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'preset-2',
            kind: 'where-used',
            name: '上游父件',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: { field: 'parent', value: 'assy', group: '装配' },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'preset-2',
            kind: 'where-used',
            name: '上游父件',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: true,
            lastDefaultSetAt: '2026-03-28T10:00:00.000Z',
            state: { field: 'parent', value: 'assy', group: '装配' },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'preset-2',
            kind: 'where-used',
            name: '上游父件',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: { field: 'parent', value: 'assy', group: '装配' },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'preset-2',
            message: 'PLM team preset deleted successfully',
          },
        }),
      })

    const saved = await savePlmTeamFilterPreset('where-used', '上游父件', {
      field: 'parent',
      value: 'assy',
      group: '装配',
    })
    const defaulted = await setPlmTeamFilterPresetDefault(saved.id)
    const cleared = await clearPlmTeamFilterPresetDefault(saved.id)
    const deleted = await deletePlmTeamFilterPreset(saved.id)

    expect(saved).toMatchObject({
      id: 'preset-2',
      kind: 'where-used',
      name: '上游父件',
    })
    expect(defaulted.isDefault).toBe(true)
    expect(defaulted.lastDefaultSetAt).toBe('2026-03-28T10:00:00.000Z')
    expect(cleared.isDefault).toBe(false)
    expect(deleted).toMatchObject({
      id: 'preset-2',
      message: 'PLM team preset deleted successfully',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/plm-workbench/filter-presets/team/preset-2/default'),
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/api/plm-workbench/filter-presets/team/preset-2/default'),
      expect.objectContaining({
        method: 'DELETE',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('/api/plm-workbench/filter-presets/team/preset-2'),
      expect.objectContaining({
        method: 'DELETE',
      }),
    )
  })

  it('duplicates and renames team presets', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'preset-copy',
            kind: 'bom',
            name: '关键 BOM（副本）',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: { field: 'path', value: 'root/a', group: '机械' },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'preset-copy',
            kind: 'bom',
            name: '关键 BOM 自定义副本',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: { field: 'path', value: 'root/a', group: '机械' },
          },
        }),
      })

    const duplicated = await duplicatePlmTeamFilterPreset('preset-source')
    const renamed = await renamePlmTeamFilterPreset('preset-copy', '关键 BOM 自定义副本')

    expect(duplicated).toMatchObject({
      id: 'preset-copy',
      kind: 'bom',
      name: '关键 BOM（副本）',
    })
    expect(renamed).toMatchObject({
      id: 'preset-copy',
      kind: 'bom',
      name: '关键 BOM 自定义副本',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/plm-workbench/filter-presets/team/preset-source/duplicate'),
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/plm-workbench/filter-presets/team/preset-copy'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: '关键 BOM 自定义副本' }),
      }),
    )
  })

  it('transfers team preset ownership', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'preset-transfer',
          kind: 'bom',
          name: '共享 BOM',
          ownerUserId: 'owner-b',
          canManage: false,
          isDefault: false,
          state: { field: 'path', value: 'root/a', group: '机械' },
        },
      }),
    })

    const transferred = await transferPlmTeamFilterPreset('preset-transfer', 'owner-b')

    expect(transferred).toMatchObject({
      id: 'preset-transfer',
      kind: 'bom',
      ownerUserId: 'owner-b',
      canManage: false,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/filter-presets/team/preset-transfer/transfer'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ownerUserId: 'owner-b' }),
      }),
    )
  })

  it('archives and restores team presets with archived metadata', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'preset-archive',
            kind: 'bom',
            name: '归档 BOM',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            isArchived: true,
            archivedAt: '2026-03-10T08:00:00.000Z',
            state: { field: 'path', value: 'root/a', group: '机械' },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'preset-archive',
            kind: 'bom',
            name: '归档 BOM',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            isArchived: false,
            state: { field: 'path', value: 'root/a', group: '机械' },
          },
        }),
      })

    const archived = await archivePlmTeamFilterPreset('preset-archive')
    const restored = await restorePlmTeamFilterPreset('preset-archive')

    expect(archived).toMatchObject({
      id: 'preset-archive',
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
    })
    expect(restored).toMatchObject({
      id: 'preset-archive',
      isArchived: false,
      archivedAt: undefined,
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/plm-workbench/filter-presets/team/preset-archive/archive'),
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/plm-workbench/filter-presets/team/preset-archive/restore'),
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('batch processes team presets', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          action: 'archive',
          processedIds: ['preset-a'],
          skippedIds: ['preset-b'],
          items: [
            {
              id: 'preset-a',
              kind: 'bom',
              name: '批量归档 BOM',
              ownerUserId: 'dev-user',
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
              isDefault: false,
              isArchived: true,
              state: { field: 'path', value: 'root/a', group: '机械' },
            },
          ],
        },
        metadata: {
          requestedTotal: 2,
          processedTotal: 1,
          skippedTotal: 1,
          processedKinds: ['bom'],
        },
      }),
    })

    const result = await batchPlmTeamFilterPresets('archive', ['preset-a', 'preset-b'])

    expect(result).toMatchObject({
      action: 'archive',
      processedIds: ['preset-a'],
      skippedIds: ['preset-b'],
      items: [
        expect.objectContaining({
          id: 'preset-a',
          isArchived: true,
          permissions: expect.objectContaining({
            canRestore: true,
          }),
        }),
      ],
      metadata: {
        requestedTotal: 2,
        processedTotal: 1,
        skippedTotal: 1,
        processedKinds: ['bom'],
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/filter-presets/team/batch'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'archive',
          ids: ['preset-a', 'preset-b'],
        }),
      }),
    )
  })

  it('lists, saves, toggles default, and deletes team views', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [
            {
              id: 'view-1',
              kind: 'documents',
              name: '共享文档视角',
              ownerUserId: 'dev-user',
              canManage: true,
              isDefault: true,
              lastDefaultSetAt: '2026-03-19T10:00:00.000Z',
              state: {
                role: 'primary',
                filter: 'gear',
                sortKey: 'updated',
                sortDir: 'desc',
                columns: { mime: true },
              },
            },
          ],
          metadata: {
            total: 4,
            activeTotal: 3,
            archivedTotal: 1,
            tenantId: 'tenant-a',
            kind: 'documents',
            defaultViewId: 'view-1',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-2',
            kind: 'documents',
            name: '共享文档视角',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: {
              role: 'primary',
              filter: 'gear',
              sortKey: 'updated',
              sortDir: 'desc',
              columns: { mime: true },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-2',
            kind: 'documents',
            name: '共享文档视角',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: true,
            state: {
              role: 'primary',
              filter: 'gear',
              sortKey: 'updated',
              sortDir: 'desc',
              columns: { mime: true },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-2',
            kind: 'documents',
            name: '共享文档视角',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: {
              role: 'primary',
              filter: 'gear',
              sortKey: 'updated',
              sortDir: 'desc',
              columns: { mime: true },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-2',
            message: 'PLM team view deleted successfully',
          },
        }),
      })

    const listed = await listPlmWorkbenchTeamViews('documents')
    const saved = await savePlmWorkbenchTeamView('documents', '共享文档视角', {
      role: 'primary',
      filter: 'gear',
      sortKey: 'updated',
      sortDir: 'desc',
      columns: { mime: true },
    })
    const defaulted = await setPlmWorkbenchTeamViewDefault('documents', saved.id)
    const cleared = await clearPlmWorkbenchTeamViewDefault('documents', saved.id)
    const deleted = await deletePlmWorkbenchTeamView(saved.id)

    expect(listed.items[0]).toMatchObject({
      id: 'view-1',
      kind: 'documents',
      isDefault: true,
      lastDefaultSetAt: '2026-03-19T10:00:00.000Z',
    })
    expect(listed.metadata).toEqual({
      total: 4,
      activeTotal: 3,
      archivedTotal: 1,
      tenantId: 'tenant-a',
      kind: 'documents',
      defaultViewId: 'view-1',
    })
    expect(saved).toMatchObject({
      id: 'view-2',
      kind: 'documents',
      name: '共享文档视角',
    })
    expect(defaulted.isDefault).toBe(true)
    expect(cleared.isDefault).toBe(false)
    expect(deleted).toMatchObject({
      id: 'view-2',
      message: 'PLM team view deleted successfully',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/plm-workbench/views/team?kind=documents'),
      expect.any(Object),
    )
    expectAuthHeader(0)
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/api/plm-workbench/views/team/view-2/default'),
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('/api/plm-workbench/views/team/view-2/default'),
      expect.objectContaining({
        method: 'DELETE',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('/api/plm-workbench/views/team/view-2'),
      expect.objectContaining({
        method: 'DELETE',
      }),
    )
  })

  it('normalizes workbench team view query snapshots', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [
            {
              id: 'view-workbench',
              kind: 'workbench',
              name: 'PLM 工作台',
              ownerUserId: 'dev-user',
              canManage: true,
              isDefault: true,
              lastDefaultSetAt: '2026-03-19T09:00:00.000Z',
              state: {
                query: {
                  productId: 'prod-100',
                  documentFilter: 'gear',
                  approvalsFilter: 'eco',
                  autoload: true,
                },
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-workbench',
            kind: 'workbench',
            name: 'PLM 工作台',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: {
              query: {
                productId: 'prod-100',
                documentFilter: 'gear',
                approvalsFilter: 'eco',
                autoload: 'true',
              },
            },
          },
        }),
      })

    const listed = await listPlmWorkbenchTeamViews('workbench')
    const saved = await savePlmWorkbenchTeamView('workbench', 'PLM 工作台', {
      query: {
        productId: 'prod-100',
        documentFilter: 'gear',
        approvalsFilter: 'eco',
        autoload: 'true',
      },
    })

    expect(listed.items[0]).toMatchObject({
      id: 'view-workbench',
      kind: 'workbench',
      lastDefaultSetAt: '2026-03-19T09:00:00.000Z',
      state: {
        query: {
          productId: 'prod-100',
          documentFilter: 'gear',
          approvalsFilter: 'eco',
          autoload: 'true',
        },
      },
    })
    expect(saved).toMatchObject({
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

  it('normalizes audit team view state by kind', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [
            {
              id: 'audit-view-1',
              kind: 'audit',
              name: '审计默认',
              ownerUserId: 'auditor',
              canManage: true,
              isDefault: true,
              state: {
                page: '2',
                q: 'documents',
                actorId: 'dev-user',
                kind: 'documents',
                action: 'ARCHIVE',
                resourceType: 'PLM-TEAM-VIEW-BATCH',
                from: '2026-03-11T15:00:00.000Z',
                to: '2026-03-11T16:00:00.000Z',
                windowMinutes: '700',
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'audit-view-2',
            kind: 'audit',
            name: '审计共享',
            ownerUserId: 'auditor',
            canManage: true,
            isDefault: false,
            state: {
              page: 3,
              q: 'bom',
              actorId: 'owner-1',
              kind: 'where-used',
              action: 'restore',
              resourceType: 'plm-team-preset-batch',
              from: '2026-03-11T17:00:00.000Z',
              to: '2026-03-11T18:00:00.000Z',
              windowMinutes: 60,
            },
          },
        }),
      })

    const listed = await listPlmWorkbenchTeamViews('audit')
    const saved = await savePlmWorkbenchTeamView('audit', '审计共享', {
      page: 3,
      q: 'bom',
      actorId: 'owner-1',
      kind: 'where-used',
      action: 'restore',
      resourceType: 'plm-team-preset-batch',
      from: '2026-03-11T17:00:00.000Z',
      to: '2026-03-11T18:00:00.000Z',
      windowMinutes: 60,
    })

    expect(listed.items[0]).toMatchObject({
      id: 'audit-view-1',
      kind: 'audit',
      state: {
        page: 2,
        q: 'documents',
        actorId: 'dev-user',
        kind: 'documents',
        action: 'archive',
        resourceType: 'plm-team-view-batch',
        from: '2026-03-11T15:00:00.000Z',
        to: '2026-03-11T16:00:00.000Z',
        windowMinutes: 720,
      },
    })
    expect(saved).toMatchObject({
      kind: 'audit',
      state: {
        page: 3,
        q: 'bom',
        actorId: 'owner-1',
        kind: 'where-used',
        action: 'restore',
        resourceType: 'plm-team-preset-batch',
        from: '2026-03-11T17:00:00.000Z',
        to: '2026-03-11T18:00:00.000Z',
        windowMinutes: 60,
      },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/plm-workbench/views/team?kind=audit'),
      expect.any(Object),
    )
    expectAuthHeader(0)
  })

  it('normalizes local audit datetime filters before saving team views', async () => {
    const expectedFrom = new Date('2026-03-11T15:00').toISOString()
    const expectedTo = new Date('2026-03-11T16:00').toISOString()

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'audit-view-local-time',
          kind: 'audit',
          name: '审计本地时间',
          ownerUserId: 'auditor',
          canManage: true,
          isDefault: false,
          state: {
            page: 1,
            q: 'documents',
            actorId: 'owner-1',
            kind: 'documents',
            action: 'archive',
            resourceType: 'plm-team-view-batch',
            from: expectedFrom,
            to: expectedTo,
            windowMinutes: 180,
          },
        },
      }),
    })

    const saved = await savePlmWorkbenchTeamView('audit', '审计本地时间', {
      page: 1,
      q: 'documents',
      actorId: 'owner-1',
      kind: 'documents',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      from: '2026-03-11T15:00',
      to: '2026-03-11T16:00',
      windowMinutes: 180,
    })

    expect(saved.state).toMatchObject({
      from: expectedFrom,
      to: expectedTo,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/views/team'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          kind: 'audit',
          name: '审计本地时间',
          state: {
            page: 1,
            q: 'documents',
            actorId: 'owner-1',
            kind: 'documents',
            action: 'archive',
            resourceType: 'plm-team-view-batch',
            from: expectedFrom,
            to: expectedTo,
            windowMinutes: 180,
          },
        }),
      }),
    )
  })

  it('passes the default flag when saving an audit team view as default', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'audit-view-default',
          kind: 'audit',
          name: '默认审计共享',
          ownerUserId: 'auditor',
          canManage: true,
          isDefault: true,
          state: {
            page: 1,
            q: 'scene-1',
            actorId: '',
            kind: 'workbench',
            action: 'set-default',
            resourceType: 'plm-team-view-default',
            from: '',
            to: '',
            windowMinutes: 180,
          },
        },
      }),
    })

    const saved = await savePlmWorkbenchTeamView('audit', '默认审计共享', {
      page: 1,
      q: 'scene-1',
      actorId: '',
      kind: 'workbench',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 180,
    }, {
      isDefault: true,
    })

    expect(saved.isDefault).toBe(true)
    expect(saved.state).toMatchObject({
      page: 1,
      q: 'scene-1',
      actorId: '',
      kind: 'workbench',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 180,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/views/team'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          kind: 'audit',
          name: '默认审计共享',
          state: {
            page: 1,
            q: 'scene-1',
            actorId: '',
            kind: 'workbench',
            action: 'set-default',
            resourceType: 'plm-team-view-default',
            from: '',
            to: '',
            windowMinutes: 180,
          },
          isDefault: true,
        }),
      }),
    )
  })

  it('preserves clear-default audit filters when listing audit team views', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'audit-view-clear-default',
            kind: 'audit',
            name: '取消默认日志',
            ownerUserId: 'auditor',
            canManage: true,
            isDefault: false,
            state: {
              page: 1,
              q: 'scene-2',
              actorId: '',
              kind: 'workbench',
              action: 'clear-default',
              resourceType: 'plm-team-view-default',
              from: '',
              to: '',
              windowMinutes: 180,
            },
          },
        ],
      }),
    })

    const listed = await listPlmWorkbenchTeamViews('audit')

    expect(listed.items[0]).toMatchObject({
      id: 'audit-view-clear-default',
      kind: 'audit',
      state: {
        page: 1,
        q: 'scene-2',
        actorId: '',
        kind: 'workbench',
        action: 'clear-default',
        resourceType: 'plm-team-view-default',
        from: '',
        to: '',
        windowMinutes: 180,
      },
    })
  })

  it('normalizes approvals and cad team view states by kind', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [
            {
              id: 'approval-view',
              kind: 'approvals',
              name: '审批默认',
              ownerUserId: 'approver',
              canManage: true,
              isDefault: true,
              state: {
                status: 'APPROVED',
                filter: 'eco',
                sortKey: 'status',
                sortDir: 'asc',
                columns: { status: true, product: false },
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [
            {
              id: 'cad-view',
              kind: 'cad',
              name: 'CAD 评审',
              ownerUserId: 'designer',
              canManage: true,
              isDefault: false,
              state: {
                fileId: 'cad-main',
                otherFileId: 'cad-other',
                reviewState: 'approved',
                reviewNote: 'ship it',
              },
            },
          ],
        }),
      })

    const approvals = await listPlmWorkbenchTeamViews('approvals')
    const cad = await listPlmWorkbenchTeamViews('cad')

    expect(approvals.items[0]).toMatchObject({
      id: 'approval-view',
      kind: 'approvals',
      state: {
        status: 'approved',
        filter: 'eco',
        sortKey: 'status',
        sortDir: 'asc',
        columns: {
          status: true,
          product: false,
        },
      },
    })
    expect(cad.items[0]).toMatchObject({
      id: 'cad-view',
      kind: 'cad',
      state: {
        fileId: 'cad-main',
        otherFileId: 'cad-other',
        reviewState: 'approved',
        reviewNote: 'ship it',
      },
    })
  })

  it('renames and duplicates workbench team views', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-workbench-1',
            kind: 'workbench',
            name: '工作台新名称',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: {
              query: {
                documentFilter: 'gear',
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-workbench-2',
            kind: 'workbench',
            name: '工作台副本',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            state: {
              query: {
                documentFilter: 'gear',
              },
            },
          },
        }),
      })

    const renamed = await renamePlmWorkbenchTeamView('workbench', 'view-workbench-1', '工作台新名称')
    const duplicated = await duplicatePlmWorkbenchTeamView('workbench', 'view-workbench-1', '工作台副本')

    expect(renamed).toMatchObject({
      id: 'view-workbench-1',
      kind: 'workbench',
      name: '工作台新名称',
    })
    expect(duplicated).toMatchObject({
      id: 'view-workbench-2',
      kind: 'workbench',
      name: '工作台副本',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/plm-workbench/views/team/view-workbench-1'),
      expect.objectContaining({
        method: 'PATCH',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/plm-workbench/views/team/view-workbench-1/duplicate'),
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('transfers workbench team view ownership', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'view-workbench-1',
          kind: 'workbench',
          name: '共享工作台',
          ownerUserId: 'owner-2',
          canManage: false,
          permissions: {
            canManage: false,
            canApply: true,
            canDuplicate: true,
            canShare: false,
            canDelete: false,
            canArchive: false,
            canRestore: false,
            canRename: false,
            canTransfer: false,
            canSetDefault: false,
            canClearDefault: false,
          },
          isDefault: false,
          state: {
            query: {
              documentFilter: 'gear',
              approvalsFilter: 'eco',
            },
          },
        },
      }),
    })

    const transferred = await transferPlmWorkbenchTeamView('workbench', 'view-workbench-1', 'owner-2')

    expect(transferred).toMatchObject({
      id: 'view-workbench-1',
      kind: 'workbench',
      ownerUserId: 'owner-2',
      canManage: false,
      permissions: {
        canManage: false,
        canShare: false,
        canTransfer: false,
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/views/team/view-workbench-1/transfer'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ownerUserId: 'owner-2' }),
      }),
    )
  })

  it('archives and restores workbench team views with archived metadata', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-workbench-1',
            kind: 'workbench',
            name: '归档工作台',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            isArchived: true,
            archivedAt: '2026-03-10T08:00:00.000Z',
            state: {
              query: {
                documentFilter: 'gear',
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'view-workbench-1',
            kind: 'workbench',
            name: '归档工作台',
            ownerUserId: 'dev-user',
            canManage: true,
            isDefault: false,
            isArchived: false,
            archivedAt: undefined,
            state: {
              query: {
                documentFilter: 'gear',
              },
            },
          },
        }),
      })

    const archived = await archivePlmWorkbenchTeamView('workbench', 'view-workbench-1')
    const restored = await restorePlmWorkbenchTeamView('workbench', 'view-workbench-1')

    expect(archived).toMatchObject({
      id: 'view-workbench-1',
      kind: 'workbench',
      isArchived: true,
      archivedAt: '2026-03-10T08:00:00.000Z',
    })
    expect(restored).toMatchObject({
      id: 'view-workbench-1',
      kind: 'workbench',
      isArchived: false,
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/plm-workbench/views/team/view-workbench-1/archive'),
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/plm-workbench/views/team/view-workbench-1/restore'),
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('batch processes panel team views', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          action: 'archive',
          processedIds: ['view-doc-a'],
          skippedIds: ['view-doc-b'],
          items: [
            {
              id: 'view-doc-a',
              kind: 'documents',
              name: '批量归档文档',
              ownerUserId: 'dev-user',
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
              isDefault: false,
              isArchived: true,
              state: {
                role: 'primary',
                filter: 'gear',
                sortKey: 'updated',
                sortDir: 'desc',
                columns: { mime: true },
              },
            },
          ],
        },
        metadata: {
          requestedTotal: 2,
          processedTotal: 1,
          skippedTotal: 1,
          processedKinds: ['documents'],
        },
      }),
    })

    const result = await batchPlmWorkbenchTeamViews('documents', 'archive', ['view-doc-a', 'view-doc-b'])

    expect(result).toMatchObject({
      action: 'archive',
      processedIds: ['view-doc-a'],
      skippedIds: ['view-doc-b'],
      items: [
        expect.objectContaining({
          id: 'view-doc-a',
          kind: 'documents',
          isArchived: true,
          permissions: expect.objectContaining({
            canRestore: true,
          }),
        }),
      ],
      metadata: {
        requestedTotal: 2,
        processedTotal: 1,
        skippedTotal: 1,
        processedKinds: ['documents'],
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/views/team/batch'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'archive',
          ids: ['view-doc-a', 'view-doc-b'],
        }),
      }),
    )
  })

  it('maps mixed-kind batch team view items using each runtime kind', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          action: 'delete',
          processedIds: ['view-cad-a', 'view-approval-a'],
          skippedIds: [],
          items: [
            {
              id: 'view-cad-a',
              kind: 'cad',
              name: 'CAD 批量 A',
              ownerUserId: 'owner-1',
              canManage: true,
              isDefault: false,
              isArchived: false,
              state: {
                fileId: 'cad-a',
                otherFileId: '',
                reviewState: 'approved',
                reviewNote: 'ok',
              },
            },
            {
              id: 'view-approval-a',
              kind: 'approvals',
              name: '审批批量 A',
              ownerUserId: 'owner-1',
              canManage: true,
              isDefault: false,
              isArchived: false,
              state: {
                status: 'pending',
                filter: 'eco',
                sortKey: 'created',
                sortDir: 'desc',
                columns: { id: true },
              },
            },
          ],
        },
      }),
    })

    const result = await batchPlmWorkbenchTeamViews('documents', 'delete', ['view-cad-a', 'view-approval-a'])

    expect(result.items).toMatchObject([
      {
        id: 'view-cad-a',
        kind: 'cad',
        state: {
          fileId: 'cad-a',
          reviewState: 'approved',
        },
      },
      {
        id: 'view-approval-a',
        kind: 'approvals',
        state: {
          status: 'pending',
          filter: 'eco',
          sortKey: 'created',
          sortDir: 'desc',
          columns: { id: true },
        },
      },
    ])
  })

  it('lists collaborative audit logs with normalized metadata', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [
            {
              id: 'audit-1',
              actorId: 'dev-user',
              actorType: 'user',
              action: 'archive',
              resourceType: 'plm-team-preset-batch',
              resourceId: 'preset-a',
              requestId: 'req-a',
              ip: '127.0.0.1',
              userAgent: 'Vitest',
              occurredAt: '2026-03-11T03:00:00.000Z',
              meta: {
                processedKinds: ['bom'],
                processedTotal: 1,
                skippedTotal: 0,
              },
            },
          ],
          page: 2,
          pageSize: 25,
          total: 40,
        },
        metadata: {
          resourceTypes: [
            'plm-team-preset-batch',
            'plm-team-view-default',
            'invalid-type',
          ],
        },
      }),
    })

    const result = await listPlmCollaborativeAuditLogs({
      page: 2,
      pageSize: 25,
      action: 'archive',
      resourceType: 'plm-team-preset-batch',
      q: 'bom',
    })

    expect(result).toMatchObject({
      page: 2,
      pageSize: 25,
      total: 40,
      resourceTypes: [
        'plm-team-preset-batch',
        'plm-team-view-default',
      ],
      items: [
        {
          id: 'audit-1',
          action: 'archive',
          resourceType: 'plm-team-preset-batch',
          meta: {
            processedKinds: ['bom'],
            processedTotal: 1,
          },
        },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/audit-logs?page=2&pageSize=25&q=bom&action=archive&resourceType=plm-team-preset-batch'),
      expect.any(Object),
    )
    expectAuthHeader(0)
  })

  it('loads collaborative audit summary buckets', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          windowMinutes: 180,
          actions: [
            { action: 'archive', total: 6 },
            { action: 'restore', total: 2 },
            { action: 'set-default', total: 1 },
          ],
          resourceTypes: [
            { resourceType: 'plm-team-view-batch', total: 5 },
            { resourceType: 'plm-team-preset-batch', total: 3 },
            { resourceType: 'plm-team-preset-default', total: 2 },
            { resourceType: 'plm-team-view-default', total: 1 },
          ],
        },
      }),
    })

    const summary = await getPlmCollaborativeAuditSummary({
      windowMinutes: 180,
      limit: 6,
    })

    expect(summary).toEqual({
      windowMinutes: 180,
      actions: [
        { action: 'archive', total: 6 },
        { action: 'restore', total: 2 },
        { action: 'set-default', total: 1 },
      ],
      resourceTypes: [
        { resourceType: 'plm-team-view-batch', total: 5 },
        { resourceType: 'plm-team-preset-batch', total: 3 },
        { resourceType: 'plm-team-preset-default', total: 2 },
        { resourceType: 'plm-team-view-default', total: 1 },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/audit-logs/summary?windowMinutes=180&limit=6'),
      expect.any(Object),
    )
    expectAuthHeader(0)
  })

  it('exports collaborative audit logs as csv', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name.toLowerCase() === 'content-disposition'
          ? 'attachment; filename="plm-audit.csv"'
          : null,
      },
      text: async () => 'occurredAt,action\n2026-03-11T03:00:00.000Z,archive\n',
    })

    const result = await exportPlmCollaborativeAuditLogsCsv({
      q: 'documents',
      actorId: 'dev-user',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      kind: 'documents',
      limit: 2000,
    })

    expect(result).toEqual({
      filename: 'plm-audit.csv',
      csvText: 'occurredAt,action\n2026-03-11T03:00:00.000Z,archive\n',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/audit-logs/export.csv?q=documents&actorId=dev-user&action=archive&resourceType=plm-team-view-batch&kind=documents&limit=2000'),
      expect.any(Object),
    )
    expect(getRequestHeaders(0).get('accept')).toBe('text/csv')
    expectAuthHeader(0)
  })

  it('maps default-scene audit logs', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [
            {
              id: 'audit-default-1',
              actorId: 'owner-1',
              actorType: 'user',
              action: 'set-default',
              resourceType: 'plm-team-view-default',
              resourceId: 'scene-1',
              requestId: 'req-default-1',
              ip: '127.0.0.1',
              userAgent: 'Vitest',
              occurredAt: '2026-03-13T07:00:00.000Z',
              meta: {
                kind: 'workbench',
                viewName: '采购团队场景',
                processedKinds: ['workbench'],
                processedTotal: 1,
              },
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
        },
      }),
    })

    const result = await listPlmCollaborativeAuditLogs({
      page: 1,
      pageSize: 20,
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      kind: 'workbench',
    })

    expect(result.items[0]).toMatchObject({
      id: 'audit-default-1',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      meta: {
        kind: 'workbench',
        viewName: '采购团队场景',
        processedKinds: ['workbench'],
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/audit-logs?page=1&pageSize=20&action=set-default&resourceType=plm-team-view-default&kind=workbench'),
      expect.any(Object),
    )
    expectAuthHeader(0)
  })

  it('maps team preset default audit logs', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [
            {
              id: 'audit-preset-default-1',
              actorId: 'owner-1',
              actorType: 'user',
              action: 'clear-default',
              resourceType: 'plm-team-preset-default',
              resourceId: 'preset-1',
              requestId: 'req-preset-default-1',
              ip: '127.0.0.1',
              userAgent: 'Vitest',
              occurredAt: '2026-03-13T08:00:00.000Z',
              meta: {
                kind: 'bom',
                viewName: 'BOM 默认预设',
                processedKinds: ['bom'],
                processedTotal: 1,
              },
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
        },
      }),
    })

    const result = await listPlmCollaborativeAuditLogs({
      page: 1,
      pageSize: 20,
      action: 'clear-default',
      resourceType: 'plm-team-preset-default',
      kind: 'bom',
    })

    expect(result.items[0]).toMatchObject({
      id: 'audit-preset-default-1',
      action: 'clear-default',
      resourceType: 'plm-team-preset-default',
      meta: {
        kind: 'bom',
        viewName: 'BOM 默认预设',
        processedKinds: ['bom'],
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/plm-workbench/audit-logs?page=1&pageSize=20&action=clear-default&resourceType=plm-team-preset-default&kind=bom'),
      expect.any(Object),
    )
    expectAuthHeader(0)
  })
})
