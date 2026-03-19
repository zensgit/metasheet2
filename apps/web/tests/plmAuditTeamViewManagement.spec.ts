import { describe, expect, it } from 'vitest'
import { buildPlmAuditTeamViewManagement } from '../src/views/plmAuditTeamViewManagement'
import type { PlmWorkbenchTeamView } from '../src/views/plm/plmPanelModels'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

function createAuditTeamView(
  overrides: Partial<PlmWorkbenchTeamView<'audit'>> = {},
): PlmWorkbenchTeamView<'audit'> {
  return {
    id: 'audit-view-1',
    kind: 'audit',
    scope: 'team',
    name: '默认审计视图',
    ownerUserId: 'owner-a',
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
      canSetDefault: true,
      canClearDefault: false,
    },
    isDefault: false,
    isArchived: false,
    state: {
      page: 1,
      q: '',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
    },
    createdAt: '2026-03-19T09:00:00.000Z',
    updatedAt: '2026-03-19T10:00:00.000Z',
    ...overrides,
  }
}

describe('plmAuditTeamViewManagement', () => {
  it('builds per-row lifecycle actions and batch counts for mixed active/archived views', () => {
    const model = buildPlmAuditTeamViewManagement([
      createAuditTeamView({
        id: 'active-view',
        name: '活跃视图',
      }),
      createAuditTeamView({
        id: 'archived-view',
        name: '已归档视图',
        isArchived: true,
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
      }),
      createAuditTeamView({
        id: 'readonly-view',
        name: '只读视图',
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
      }),
    ], ['active-view', 'archived-view'], tr)

    expect(model.selectableCount).toBe(2)
    expect(model.selectedCount).toBe(2)
    expect(model.items).toEqual([
      expect.objectContaining({
        id: 'active-view',
        selectable: true,
        selected: true,
        lifecycleActions: [
          expect.objectContaining({ kind: 'archive' }),
          expect.objectContaining({ kind: 'delete' }),
        ],
      }),
      expect.objectContaining({
        id: 'archived-view',
        selectable: true,
        selected: true,
        lifecycleActions: [
          expect.objectContaining({ kind: 'restore' }),
          expect.objectContaining({ kind: 'delete' }),
        ],
      }),
      expect.objectContaining({
        id: 'readonly-view',
        selectable: false,
        selected: false,
        selectionHint:
          'This team view is read-only in the current account.|当前账号对这个团队视图只有只读权限。',
        lifecycleActions: [],
      }),
    ])
    expect(model.batchActions).toEqual([
      expect.objectContaining({
        kind: 'archive',
        disabled: false,
        eligibleCount: 1,
        eligibleIds: ['active-view'],
      }),
      expect.objectContaining({
        kind: 'restore',
        disabled: false,
        eligibleCount: 1,
        eligibleIds: ['archived-view'],
      }),
      expect.objectContaining({
        kind: 'delete',
        disabled: false,
        eligibleCount: 2,
        eligibleIds: ['active-view', 'archived-view'],
      }),
    ])
  })

  it('disables batch actions when nothing eligible is selected', () => {
    const model = buildPlmAuditTeamViewManagement([
      createAuditTeamView({
        id: 'readonly-view',
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
      }),
    ], ['readonly-view'], tr)

    expect(model.batchActions).toEqual([
      expect.objectContaining({
        kind: 'archive',
        disabled: true,
        eligibleCount: 0,
      }),
      expect.objectContaining({
        kind: 'restore',
        disabled: true,
        eligibleCount: 0,
      }),
      expect.objectContaining({
        kind: 'delete',
        disabled: true,
        eligibleCount: 0,
      }),
    ])
  })
})
