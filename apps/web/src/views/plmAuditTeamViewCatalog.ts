import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'

export type PlmRecommendedAuditTeamViewReason = 'default' | 'recent-default' | 'recent-update'
export type PlmRecommendedAuditTeamViewFilter = '' | PlmRecommendedAuditTeamViewReason

export type PlmRecommendedAuditTeamView = {
  id: string
  name: string
  ownerUserId: string
  isDefault: boolean
  lastDefaultSetAt?: string
  recommendationReason: PlmRecommendedAuditTeamViewReason
  recommendationSourceLabel: string
  recommendationSourceTimestamp?: string
  primaryActionKind: 'apply-view'
  primaryActionLabel: string
  secondaryActionKind: 'copy-link' | 'set-default'
  secondaryActionLabel: string
  managementActionKind: 'focus-management'
  managementActionLabel: string
  actionNote: string
  updatedAt?: string
}

export type PlmAuditTeamViewSummaryChip = {
  value: PlmRecommendedAuditTeamViewFilter
  label: string
  count: number
  active: boolean
}

export type PlmAuditTeamViewSummaryHint = {
  value: PlmRecommendedAuditTeamViewFilter
  label: string
  count: number
  description: string
}

const AUDIT_TEAM_VIEW_RECOMMENDATION_DESCRIPTIONS: Record<string, string> = {
  '': '综合展示当前默认、近期默认和近期更新的审计团队视图，适合快速进入协作审计入口。',
  default: '只看当前默认审计团队视图，适合作为团队标准审计入口。',
  'recent-default': '只看近期被设为默认的审计团队视图，适合追踪默认切换历史。',
  'recent-update': '只看最近更新的审计团队视图，适合发现近期维护过的审计入口。',
}

function getAuditTeamViewTimestamp(value?: string) {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getRecommendationReason(
  view: PlmWorkbenchTeamView<'audit'>,
): PlmRecommendedAuditTeamViewReason {
  if (view.isDefault) return 'default'
  if (view.lastDefaultSetAt) return 'recent-default'
  return 'recent-update'
}

export function resolveAuditTeamViewRecommendationFilter(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'isDefault' | 'lastDefaultSetAt'>,
): PlmRecommendedAuditTeamViewFilter {
  return getRecommendationReason(view as PlmWorkbenchTeamView<'audit'>)
}

function getRecommendationSource(
  view: PlmWorkbenchTeamView<'audit'>,
  recommendationReason: PlmRecommendedAuditTeamViewReason,
) {
  if (recommendationReason === 'default') {
    return {
      label: '当前默认审计视图',
      timestamp: view.lastDefaultSetAt || view.updatedAt || view.createdAt,
    }
  }

  if (recommendationReason === 'recent-default') {
    return {
      label: '近期被设为默认的审计视图',
      timestamp: view.lastDefaultSetAt,
    }
  }

  return {
    label: '近期更新的审计视图',
    timestamp: view.updatedAt || view.createdAt,
  }
}

function canRecommendAsDefault(view: PlmWorkbenchTeamView<'audit'>) {
  if (view.isArchived || view.isDefault) return false
  return view.permissions?.canSetDefault ?? (view.canManage && !view.isDefault)
}

function getRecommendationActions(
  view: PlmWorkbenchTeamView<'audit'>,
  recommendationReason: PlmRecommendedAuditTeamViewReason,
) {
  const canSetDefault = canRecommendAsDefault(view)
  const recommendSetDefaultKind: 'set-default' | 'copy-link' = canSetDefault ? 'set-default' : 'copy-link'

  if (recommendationReason === 'default') {
    return {
      primaryActionKind: 'apply-view' as const,
      primaryActionLabel: '进入默认视图',
      secondaryActionKind: 'copy-link' as const,
      secondaryActionLabel: '复制默认链接',
      managementActionLabel: '管理默认视图',
      actionNote: '当前默认审计视图更适合作为稳定入口，可直接复制链接分享给团队。',
    }
  }

  if (recommendationReason === 'recent-default') {
    return {
      primaryActionKind: 'apply-view' as const,
      primaryActionLabel: '查看近期默认',
      secondaryActionKind: recommendSetDefaultKind,
      secondaryActionLabel: canSetDefault ? '重新设为默认' : '复制视图链接',
      managementActionLabel: '管理近期默认',
      actionNote: canSetDefault
        ? '该视图近期被设为默认，可直接重新提升为团队默认入口。'
        : '该视图近期被设为默认，建议先应用或复制链接继续协作。',
    }
  }

  return {
    primaryActionKind: 'apply-view' as const,
    primaryActionLabel: '查看最新更新',
    secondaryActionKind: recommendSetDefaultKind,
    secondaryActionLabel: canSetDefault ? '设为默认' : '复制视图链接',
    managementActionLabel: '管理最新更新',
    actionNote: canSetDefault
      ? '该视图近期更新且可直接提升为默认，适合快速切换团队审计入口。'
      : '该视图因近期更新被推荐，建议先应用或复制链接后再扩散。',
  }
}

function getEligibleAuditTeamViews(views: PlmWorkbenchTeamView<'audit'>[]) {
  return views.filter((view) => !view.isArchived)
}

export function buildRecommendedAuditTeamViews(
  views: PlmWorkbenchTeamView<'audit'>[],
  options?: {
    recommendationFilter?: PlmRecommendedAuditTeamViewFilter
  },
): PlmRecommendedAuditTeamView[] {
  const recommendationFilter = options?.recommendationFilter || ''

  return getEligibleAuditTeamViews(views)
    .map((view) => ({
      view,
      recommendationReason: getRecommendationReason(view),
    }))
    .filter((entry) => !recommendationFilter || entry.recommendationReason === recommendationFilter)
    .sort((left, right) => {
      if (left.view.isDefault !== right.view.isDefault) {
        return Number(right.view.isDefault) - Number(left.view.isDefault)
      }

      const rightDefault = getAuditTeamViewTimestamp(right.view.lastDefaultSetAt)
      const leftDefault = getAuditTeamViewTimestamp(left.view.lastDefaultSetAt)
      if (rightDefault !== leftDefault) {
        return rightDefault - leftDefault
      }

      const rightUpdated = getAuditTeamViewTimestamp(right.view.updatedAt || right.view.createdAt)
      const leftUpdated = getAuditTeamViewTimestamp(left.view.updatedAt || left.view.createdAt)
      if (rightUpdated !== leftUpdated) {
        return rightUpdated - leftUpdated
      }

      return left.view.name.localeCompare(right.view.name, 'zh-CN')
    })
    .slice(0, 6)
    .map(({ view, recommendationReason }) => {
      const recommendationSource = getRecommendationSource(view, recommendationReason)
      const recommendationActions = getRecommendationActions(view, recommendationReason)
      return {
        id: view.id,
        name: view.name,
        ownerUserId: view.ownerUserId,
        isDefault: Boolean(view.isDefault),
        lastDefaultSetAt: view.lastDefaultSetAt,
        recommendationReason,
        recommendationSourceLabel: recommendationSource.label,
        recommendationSourceTimestamp: recommendationSource.timestamp,
        primaryActionKind: recommendationActions.primaryActionKind,
        primaryActionLabel: recommendationActions.primaryActionLabel,
        secondaryActionKind: recommendationActions.secondaryActionKind,
        secondaryActionLabel: recommendationActions.secondaryActionLabel,
        managementActionKind: 'focus-management',
        managementActionLabel: recommendationActions.managementActionLabel,
        actionNote: recommendationActions.actionNote,
        updatedAt: view.updatedAt,
      }
    })
}

export function buildAuditTeamViewSummaryChips(
  views: PlmWorkbenchTeamView<'audit'>[],
  options?: {
    recommendationFilter?: PlmRecommendedAuditTeamViewFilter
  },
): PlmAuditTeamViewSummaryChip[] {
  const eligibleViews = getEligibleAuditTeamViews(views)
  const recommendationFilter = options?.recommendationFilter || ''
  const counts = {
    all: eligibleViews.length,
    default: 0,
    'recent-default': 0,
    'recent-update': 0,
  } as const satisfies Record<string, number>

  const summaryCounts = {
    ...counts,
  }

  for (const view of eligibleViews) {
    const reason = getRecommendationReason(view)
    summaryCounts[reason] += 1
  }

  return [
    { value: '', label: '全部推荐', count: summaryCounts.all, active: recommendationFilter === '' },
    { value: 'default', label: '当前默认', count: summaryCounts.default, active: recommendationFilter === 'default' },
    {
      value: 'recent-default',
      label: '近期默认',
      count: summaryCounts['recent-default'],
      active: recommendationFilter === 'recent-default',
    },
    {
      value: 'recent-update',
      label: '近期更新',
      count: summaryCounts['recent-update'],
      active: recommendationFilter === 'recent-update',
    },
  ]
}

export function buildAuditTeamViewSummaryHint(
  chips: PlmAuditTeamViewSummaryChip[],
): PlmAuditTeamViewSummaryHint {
  const activeChip = chips.find((chip) => chip.active) || chips[0] || {
    value: '',
    label: '全部推荐',
    count: 0,
    active: true,
  }

  return {
    value: activeChip.value,
    label: activeChip.label,
    count: activeChip.count,
    description:
      AUDIT_TEAM_VIEW_RECOMMENDATION_DESCRIPTIONS[activeChip.value]
      || AUDIT_TEAM_VIEW_RECOMMENDATION_DESCRIPTIONS[''],
  }
}
