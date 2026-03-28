import { describe, expect, it } from 'vitest'
import {
  buildAuditTeamViewSummaryChips,
  buildAuditTeamViewSummaryHint,
  buildRecommendedAuditTeamViews,
  consumeStaleRecommendedAuditTeamViewFocusId,
  resolveApplicableRecommendedAuditTeamView,
  resolvePlmRecommendedAuditTeamViewActionFeedback,
  resolveAuditTeamViewRecommendationFilter,
  shouldShowAuditTeamViewRecommendations,
} from '../src/views/plmAuditTeamViewCatalog'
import type { PlmWorkbenchTeamView } from '../src/views/plm/plmPanelModels'

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

describe('plmAuditTeamViewCatalog', () => {
  it('prioritizes current default, then recent defaults, then recent updates', () => {
    const views = buildRecommendedAuditTeamViews([
      createAuditTeamView({
        id: 'updated',
        name: '最近更新',
        updatedAt: '2026-03-19T14:00:00.000Z',
      }),
      createAuditTeamView({
        id: 'recent-default',
        name: '近期默认',
        lastDefaultSetAt: '2026-03-19T15:00:00.000Z',
      }),
      createAuditTeamView({
        id: 'default',
        name: '当前默认',
        isDefault: true,
        lastDefaultSetAt: '2026-03-19T16:00:00.000Z',
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
      }),
    ])

    expect(views.map((item) => item.id)).toEqual(['default', 'recent-default', 'updated'])
    expect(views[0]).toMatchObject({
      recommendationReason: 'default',
      secondaryActionKind: 'copy-link',
      secondaryActionLabel: '复制默认链接',
      managementActionLabel: '管理默认视图',
    })
    expect(views[1]).toMatchObject({
      recommendationReason: 'recent-default',
      secondaryActionKind: 'set-default',
      secondaryActionLabel: '重新设为默认',
      managementActionLabel: '管理近期默认',
    })
    expect(views[2]).toMatchObject({
      recommendationReason: 'recent-update',
      secondaryActionKind: 'set-default',
      secondaryActionLabel: '设为默认',
      managementActionLabel: '管理最新更新',
    })
  })

  it('falls back to copy-link when the recommended view cannot be set as default', () => {
    const [view] = buildRecommendedAuditTeamViews([
      createAuditTeamView({
        id: 'recent-default',
        name: '近期默认',
        lastDefaultSetAt: '2026-03-19T15:00:00.000Z',
        permissions: {
          canManage: false,
          canApply: true,
          canDuplicate: true,
          canShare: true,
          canDelete: false,
          canArchive: false,
          canRestore: false,
          canRename: false,
          canTransfer: false,
          canSetDefault: false,
          canClearDefault: false,
        },
      }),
    ])

    expect(view).toMatchObject({
      secondaryActionKind: 'copy-link',
      secondaryActionLabel: '复制视图链接',
      secondaryActionDisabled: false,
    })
  })

  it('disables recommended copy-link actions when the underlying team view cannot be shared', () => {
    const [view] = buildRecommendedAuditTeamViews([
      createAuditTeamView({
        id: 'default',
        isDefault: true,
        permissions: {
          ...createAuditTeamView().permissions,
          canShare: false,
          canSetDefault: false,
          canClearDefault: false,
        },
      }),
    ])

    expect(view).toMatchObject({
      secondaryActionKind: 'copy-link',
      secondaryActionLabel: '复制默认链接',
      secondaryActionDisabled: true,
    })
  })

  it('marks recommended apply actions as disabled when the target is no longer applicable', () => {
    const [view] = buildRecommendedAuditTeamViews([
      createAuditTeamView({
        id: 'recent-update',
        permissions: {
          ...createAuditTeamView().permissions,
          canApply: false,
        },
      }),
    ])

    expect(view).toMatchObject({
      primaryActionKind: 'apply-view',
      primaryActionDisabled: true,
    })
  })

  it('builds summary chips and hint from recommendation counts', () => {
    const chips = buildAuditTeamViewSummaryChips([
      createAuditTeamView({ id: 'default', isDefault: true }),
      createAuditTeamView({ id: 'recent-default', lastDefaultSetAt: '2026-03-19T15:00:00.000Z' }),
      createAuditTeamView({ id: 'updated', updatedAt: '2026-03-19T16:00:00.000Z' }),
    ], {
      recommendationFilter: 'recent-default',
    })

    expect(chips).toEqual([
      { value: '', label: '全部推荐', count: 3, active: false },
      { value: 'default', label: '当前默认', count: 1, active: false },
      { value: 'recent-default', label: '近期默认', count: 1, active: true },
      { value: 'recent-update', label: '近期更新', count: 1, active: false },
    ])
    expect(buildAuditTeamViewSummaryHint(chips)).toEqual({
      value: 'recent-default',
      label: '近期默认',
      count: 1,
      description: '只看近期被设为默认的审计团队视图，适合追踪默认切换历史。',
    })
  })

  it('keeps recommendation chips visible when the active bucket is empty', () => {
    const chips = buildAuditTeamViewSummaryChips([
      createAuditTeamView({ id: 'default', isDefault: true }),
    ], {
      recommendationFilter: 'recent-default',
    })

    expect(chips).toEqual([
      { value: '', label: '全部推荐', count: 1, active: false },
      { value: 'default', label: '当前默认', count: 1, active: false },
      { value: 'recent-default', label: '近期默认', count: 0, active: true },
      { value: 'recent-update', label: '近期更新', count: 0, active: false },
    ])
    expect(shouldShowAuditTeamViewRecommendations(chips)).toBe(true)
  })

  it('resolves the recommended filter bucket for a team view', () => {
    expect(resolveAuditTeamViewRecommendationFilter(createAuditTeamView({
      isDefault: true,
      lastDefaultSetAt: '2026-03-19T16:00:00.000Z',
    }))).toBe('default')
    expect(resolveAuditTeamViewRecommendationFilter(createAuditTeamView({
      lastDefaultSetAt: '2026-03-19T15:00:00.000Z',
    }))).toBe('recent-default')
    expect(resolveAuditTeamViewRecommendationFilter(createAuditTeamView())).toBe('recent-update')
  })

  it('consumes focused recommendation ids that are no longer visible in the current catalog', () => {
    const visibleViews = buildRecommendedAuditTeamViews([
      createAuditTeamView({ id: 'default', isDefault: true }),
      createAuditTeamView({ id: 'recent-default', lastDefaultSetAt: '2026-03-19T15:00:00.000Z' }),
    ], {
      recommendationFilter: 'default',
    })

    expect(consumeStaleRecommendedAuditTeamViewFocusId(visibleViews, 'default')).toBe('default')
    expect(consumeStaleRecommendedAuditTeamViewFocusId(visibleViews, 'recent-default')).toBe('')
    expect(consumeStaleRecommendedAuditTeamViewFocusId(visibleViews, '')).toBe('')
  })

  it('only resolves recommended apply targets that still pass applyability gating', () => {
    const basePermissions = createAuditTeamView().permissions
    const applicable = createAuditTeamView({ id: 'applicable' })
    const readOnly = createAuditTeamView({
      id: 'read-only',
      permissions: {
        ...basePermissions,
        canApply: false,
      },
    })
    const archived = createAuditTeamView({
      id: 'archived',
      isArchived: true,
      permissions: {
        ...basePermissions,
        canApply: false,
      },
    })

    expect(resolveApplicableRecommendedAuditTeamView([applicable, readOnly, archived], 'applicable')?.id).toBe('applicable')
    expect(resolveApplicableRecommendedAuditTeamView([applicable, readOnly, archived], 'read-only')).toBeNull()
    expect(resolveApplicableRecommendedAuditTeamView([applicable, readOnly, archived], 'archived')).toBeNull()
    expect(resolveApplicableRecommendedAuditTeamView([applicable], 'missing')).toBeNull()
  })

  it('returns explicit feedback when a recommended apply target is no longer applicable', () => {
    expect(resolvePlmRecommendedAuditTeamViewActionFeedback({
      actionKind: 'apply',
      target: createAuditTeamView({
        id: 'archived',
        isArchived: true,
        permissions: {
          ...createAuditTeamView().permissions,
          canApply: false,
        },
      }),
      tr: (en, zh) => `${en}|${zh}`,
    })).toEqual({
      kind: 'error',
      message: 'Restore the audit team view before applying it.|请先恢复审计团队视图，再执行应用。',
    })
  })

  it('returns explicit feedback when a recommended secondary target cannot be shared or defaulted', () => {
    expect(resolvePlmRecommendedAuditTeamViewActionFeedback({
      actionKind: 'share',
      target: createAuditTeamView({
        permissions: {
          ...createAuditTeamView().permissions,
          canShare: false,
        },
      }),
      tr: (en, zh) => `${en}|${zh}`,
    })).toEqual({
      kind: 'error',
      message: 'Current recommended audit team view cannot be shared.|当前推荐审计团队视图不可分享。',
    })

    expect(resolvePlmRecommendedAuditTeamViewActionFeedback({
      actionKind: 'set-default',
      target: createAuditTeamView({
        isDefault: true,
        permissions: {
          ...createAuditTeamView().permissions,
          canSetDefault: false,
          canClearDefault: true,
        },
      }),
      tr: (en, zh) => `${en}|${zh}`,
    })).toEqual({
      kind: 'info',
      message: 'Audit team view already set as default.|审计团队视图已设为默认。',
    })
  })

  it('returns explicit feedback when a recommended management target disappears', () => {
    expect(resolvePlmRecommendedAuditTeamViewActionFeedback({
      actionKind: 'manage',
      target: null,
      tr: (en, zh) => `${en}|${zh}`,
    })).toEqual({
      kind: 'error',
      message: 'Current recommended audit team view is unavailable.|当前推荐审计团队视图不可用。',
    })
  })
})
