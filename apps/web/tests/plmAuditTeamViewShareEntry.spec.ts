import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditSharedEntrySavedViewName,
  buildPlmAuditTeamViewShareEntryNotice,
  findPlmAuditTeamViewShareEntryView,
  isPlmAuditSharedLinkEntry,
  prunePlmAuditTeamViewShareEntryForRemovedViews,
  resolvePlmAuditSharedEntryTakeoverSelection,
  resolvePlmAuditTeamViewShareEntryActionTarget,
  resolvePlmAuditSharedEntryRouteSyncDecision,
  shouldKeepPlmAuditTeamViewShareEntry,
  shouldTakeOverPlmAuditSharedEntryOnManagementHandoff,
  shouldTakeOverPlmAuditSharedEntryOnLocalSave,
  shouldTakeOverPlmAuditSharedEntryOnSavedViewTakeover,
  shouldTakeOverPlmAuditSharedEntryOnSourceAction,
  shouldResolvePlmAuditSharedEntryOnQueryChange,
  reducePlmAuditTeamViewShareEntry,
  resolvePlmAuditTeamViewShareEntryActionFeedback,
} from '../src/views/plmAuditTeamViewShareEntry'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditTeamViewShareEntry', () => {
  it('detects share-entry query markers', () => {
    expect(isPlmAuditSharedLinkEntry('share')).toBe(true)
    expect(isPlmAuditSharedLinkEntry('')).toBe(false)
    expect(isPlmAuditSharedLinkEntry(undefined)).toBe(false)
  })

  it('builds shared-link entry actions for active team views', () => {
    expect(buildPlmAuditTeamViewShareEntryNotice({
      id: 'audit-view-1',
      isDefault: false,
      isArchived: false,
    }, {
      teamViewId: 'audit-view-1',
    }, {
      canDuplicate: true,
      canSetDefault: true,
    }, tr)).toEqual({
      sourceLabel: 'Shared team view link|团队视图分享链接',
      title: 'Opened from a shared audit team view.|已通过分享链接打开审计团队视图。',
      description:
        'This team view came from a share link. You can keep exploring it, duplicate it into your own workflow, or promote it to the default audit entry.|这个团队视图来自分享链接。你可以继续查看，也可以复制到自己的工作流里，或将其提升为默认审计入口。',
      actions: [
        {
          kind: 'save-local',
          label: 'Save as local view|保存为本地视图',
          emphasis: 'primary',
        },
        {
          kind: 'duplicate',
          label: 'Duplicate for my workflow|复制为我的工作流视图',
          emphasis: 'secondary',
        },
        {
          kind: 'set-default',
          label: 'Set as default|设为默认',
          emphasis: 'secondary',
        },
        {
          kind: 'dismiss',
          label: 'Dismiss|关闭',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('finds the shared-entry target view independently from the local selector state', () => {
    expect(findPlmAuditTeamViewShareEntryView([
      { id: 'audit-view-1', name: 'A' },
      { id: 'audit-view-2', name: 'B' },
    ], {
      teamViewId: 'audit-view-1',
    })).toEqual({
      id: 'audit-view-1',
      name: 'A',
    })

    expect(findPlmAuditTeamViewShareEntryView([
      { id: 'audit-view-1', name: 'A' },
    ], {
      teamViewId: 'audit-view-2',
    })).toBeNull()
  })

  it('clears stale batch selection when a shared-entry takeover installs its own owner', () => {
    expect(resolvePlmAuditSharedEntryTakeoverSelection([
      'audit-view-1',
      'audit-view-2',
    ])).toEqual([])

    expect(resolvePlmAuditSharedEntryTakeoverSelection([])).toEqual([])
  })

  it('keeps shared-entry notice actions pinned to the canonical entry target', () => {
    expect(resolvePlmAuditTeamViewShareEntryActionTarget(
      { id: 'audit-view-1', name: 'A' },
      { id: 'audit-view-2', name: 'B' },
    )).toEqual({
      id: 'audit-view-1',
      name: 'A',
    })

    expect(resolvePlmAuditTeamViewShareEntryActionTarget(
      null,
      { id: 'audit-view-2', name: 'B' },
    )).toBeNull()
  })

  it('omits unavailable actions for default archived views', () => {
    expect(buildPlmAuditTeamViewShareEntryNotice({
      id: 'audit-view-2',
      isDefault: true,
      isArchived: true,
    }, {
      teamViewId: 'audit-view-2',
    }, {
      canDuplicate: false,
      canSetDefault: false,
    }, tr)?.actions).toEqual([
      {
        kind: 'dismiss',
        label: 'Dismiss|关闭',
        emphasis: 'secondary',
      },
    ])
  })

  it('returns explicit feedback when a shared-entry action target is unavailable', () => {
    expect(resolvePlmAuditTeamViewShareEntryActionFeedback({
      actionKind: 'duplicate',
      target: null,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Current shared audit team view action is unavailable.|当前分享的审计团队视图动作不可用。',
    })
  })

  it('returns explicit feedback when a shared-entry action is archived or no-op', () => {
    expect(resolvePlmAuditTeamViewShareEntryActionFeedback({
      actionKind: 'save-local',
      target: {
        id: 'audit-view-3',
        kind: 'audit',
        scope: 'team',
        name: 'Archived',
        ownerUserId: 'owner-a',
        canManage: true,
        permissions: {
          canManage: true,
          canApply: false,
          canDuplicate: false,
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
      },
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Restore the audit team view before saving it locally.|请先恢复审计团队视图，再保存为本地视图。',
    })

    expect(resolvePlmAuditTeamViewShareEntryActionFeedback({
      actionKind: 'set-default',
      target: {
        id: 'audit-view-4',
        kind: 'audit',
        scope: 'team',
        name: 'Default',
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
          canSetDefault: false,
          canClearDefault: true,
        },
        isDefault: true,
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
      },
      tr,
    })).toEqual({
      kind: 'info',
      message: 'Audit team view already set as default.|审计团队视图已设为默认。',
    })
  })

  it('builds the default local saved-view name for shared entries', () => {
    expect(buildPlmAuditSharedEntrySavedViewName({
      name: 'Supplier audit baseline',
    }, tr)).toBe('Supplier audit baseline · Local view|本地视图')
  })

  it('clears shared-link entry notices when filter navigation takes over', () => {
    expect(reducePlmAuditTeamViewShareEntry({
      teamViewId: 'audit-view-1',
    }, {
      kind: 'filter-navigation',
    })).toBeNull()

    expect(reducePlmAuditTeamViewShareEntry(null, {
      kind: 'filter-navigation',
    })).toBeNull()
  })

  it('clears shared-link entry notices when the route no longer carries the share marker', () => {
    expect(reducePlmAuditTeamViewShareEntry({
      teamViewId: 'audit-view-1',
    }, {
      kind: 'route-query',
      auditEntry: '',
    })).toBeNull()

    expect(reducePlmAuditTeamViewShareEntry({
      teamViewId: 'audit-view-1',
    }, {
      kind: 'route-query',
      auditEntry: 'share',
    })).toEqual({
      teamViewId: 'audit-view-1',
    })
  })

  it('keeps shared-link entry notices tied to the canonical team-view route only', () => {
    expect(shouldKeepPlmAuditTeamViewShareEntry({
      teamViewId: 'audit-view-1',
    }, 'audit-view-1')).toBe(true)

    expect(shouldKeepPlmAuditTeamViewShareEntry({
      teamViewId: 'audit-view-1',
    }, 'audit-view-2')).toBe(false)

    expect(shouldKeepPlmAuditTeamViewShareEntry(null, 'audit-view-1')).toBe(false)
  })

  it('clears shared-entry ownership when the owning team view entry is removed', () => {
    expect(prunePlmAuditTeamViewShareEntryForRemovedViews({
      teamViewId: 'audit-view-1',
    }, ['audit-view-1'])).toBeNull()

    expect(prunePlmAuditTeamViewShareEntryForRemovedViews({
      teamViewId: 'audit-view-1',
    }, ['audit-view-2'])).toEqual({
      teamViewId: 'audit-view-1',
    })
  })

  it('only treats local saves as shared-entry takeovers when the selected team view still matches the shared entry', () => {
    expect(shouldTakeOverPlmAuditSharedEntryOnLocalSave({
      teamViewId: 'audit-view-1',
    }, 'audit-view-1')).toBe(true)

    expect(shouldTakeOverPlmAuditSharedEntryOnLocalSave({
      teamViewId: 'audit-view-1',
    }, 'audit-view-2')).toBe(false)

    expect(shouldTakeOverPlmAuditSharedEntryOnLocalSave(null, 'audit-view-1')).toBe(false)
  })

  it('only treats recommendation management handoffs as takeovers when the target still matches the shared entry', () => {
    expect(shouldTakeOverPlmAuditSharedEntryOnManagementHandoff({
      teamViewId: 'audit-view-1',
    }, 'audit-view-1')).toBe(true)

    expect(shouldTakeOverPlmAuditSharedEntryOnManagementHandoff({
      teamViewId: 'audit-view-1',
    }, 'audit-view-2')).toBe(false)

    expect(shouldTakeOverPlmAuditSharedEntryOnManagementHandoff(null, 'audit-view-1')).toBe(false)
  })

  it('always treats saved-view takeovers as shared-entry owner takeovers', () => {
    expect(shouldTakeOverPlmAuditSharedEntryOnSavedViewTakeover({
      teamViewId: 'audit-view-1',
    })).toBe(true)

    expect(shouldTakeOverPlmAuditSharedEntryOnSavedViewTakeover(null)).toBe(false)
  })

  it('only treats source-aware collaboration actions as takeovers when the target still matches the shared entry', () => {
    expect(shouldTakeOverPlmAuditSharedEntryOnSourceAction({
      teamViewId: 'audit-view-1',
    }, true, 'audit-view-1')).toBe(true)

    expect(shouldTakeOverPlmAuditSharedEntryOnSourceAction({
      teamViewId: 'audit-view-1',
    }, true, 'audit-view-2')).toBe(false)

    expect(shouldTakeOverPlmAuditSharedEntryOnSourceAction({
      teamViewId: 'audit-view-1',
    }, false, 'audit-view-1')).toBe(false)

    expect(shouldTakeOverPlmAuditSharedEntryOnSourceAction(null, true, 'audit-view-1')).toBe(false)
  })

  it('forces a replace sync when share-entry cleanup must consume a stale route marker', () => {
    expect(resolvePlmAuditSharedEntryRouteSyncDecision({
      routeChanged: false,
      replace: false,
      consumeSharedEntry: true,
      auditEntry: 'share',
    })).toEqual({
      shouldSync: true,
      replace: true,
    })

    expect(resolvePlmAuditSharedEntryRouteSyncDecision({
      routeChanged: false,
      replace: false,
      consumeSharedEntry: false,
      auditEntry: 'share',
    })).toEqual({
      shouldSync: false,
      replace: true,
    })

    expect(resolvePlmAuditSharedEntryRouteSyncDecision({
      routeChanged: true,
      replace: false,
      consumeSharedEntry: false,
      auditEntry: '',
    })).toEqual({
      shouldSync: true,
      replace: false,
    })
  })

  it('treats a marker-only transition into auditEntry=share as a shared-entry takeover', () => {
    expect(shouldResolvePlmAuditSharedEntryOnQueryChange({
      routeReady: true,
      routeChanged: false,
      teamViewId: 'audit-view-1',
      nextAuditEntry: 'share',
      previousAuditEntry: '',
    })).toBe(true)

    expect(shouldResolvePlmAuditSharedEntryOnQueryChange({
      routeReady: true,
      routeChanged: false,
      teamViewId: '',
      nextAuditEntry: 'share',
      previousAuditEntry: '',
    })).toBe(false)

    expect(shouldResolvePlmAuditSharedEntryOnQueryChange({
      routeReady: true,
      routeChanged: true,
      teamViewId: 'audit-view-1',
      nextAuditEntry: 'share',
      previousAuditEntry: '',
    })).toBe(false)

    expect(shouldResolvePlmAuditSharedEntryOnQueryChange({
      routeReady: true,
      routeChanged: false,
      teamViewId: 'audit-view-1',
      nextAuditEntry: 'share',
      previousAuditEntry: 'share',
    })).toBe(false)
  })
})
