import type {
  FilterFieldOption,
  PlmRecommendedWorkbenchScene,
  PlmWorkbenchSceneSummaryChip,
  PlmWorkbenchSceneSummaryHint,
  PlmWorkbenchSceneRecommendationFilter,
  PlmWorkbenchTeamView,
} from './plmPanelModels'
import { canSharePlmCollaborativeEntry } from '../plm/usePlmCollaborativePermissions'

export const WORKBENCH_SCENE_RECOMMENDATION_OPTIONS: FilterFieldOption[] = [
  { value: '', label: '全部推荐' },
  { value: 'default', label: '当前默认' },
  { value: 'recent-default', label: '近期默认' },
  { value: 'recent-update', label: '近期更新' },
]

const WORKBENCH_SCENE_RECOMMENDATION_DESCRIPTIONS: Record<string, string> = {
  '': '综合展示当前默认、近期默认和近期更新的团队场景，适合快速进入工作台。',
  default: '只看当前团队默认场景，适合快速进入标准作业入口。',
  'recent-default': '只看近期被设为默认的场景，适合追踪最近切换过的推荐入口。',
  'recent-update': '只看最近更新的场景，适合追踪近期维护或调整过的工作台。',
}

function getSceneTimestamp(value?: string) {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getRecommendationReason(view: PlmWorkbenchTeamView<'workbench'>): PlmRecommendedWorkbenchScene['recommendationReason'] {
  if (view.isDefault) return 'default'
  if (view.lastDefaultSetAt) return 'recent-default'
  return 'recent-update'
}

function getRecommendationSource(
  view: PlmWorkbenchTeamView<'workbench'>,
  recommendationReason: PlmRecommendedWorkbenchScene['recommendationReason'],
) {
  if (recommendationReason === 'default') {
    return {
      label: '当前团队默认场景',
      timestamp: view.lastDefaultSetAt || view.updatedAt || view.createdAt,
    }
  }

  if (recommendationReason === 'recent-default') {
    return {
      label: '近期被设为团队默认场景',
      timestamp: view.lastDefaultSetAt,
    }
  }

  return {
    label: '近期更新的团队场景',
    timestamp: view.updatedAt || view.createdAt,
  }
}

function getRecommendationActions(
  view: PlmWorkbenchTeamView<'workbench'>,
  recommendationReason: PlmRecommendedWorkbenchScene['recommendationReason'],
) {
  const canShare = canSharePlmCollaborativeEntry(view)
  if (recommendationReason === 'default') {
    return {
      primaryActionKind: 'apply-scene' as const,
      primaryActionLabel: '进入默认场景',
      secondaryActionKind: 'copy-link' as const,
      secondaryActionLabel: '复制默认链接',
      secondaryActionDisabled: !canShare,
      actionNote: '当前默认场景更适合作为稳定入口，可直接复制链接发给团队成员。',
    }
  }

  if (recommendationReason === 'recent-default') {
    return {
      primaryActionKind: 'apply-scene' as const,
      primaryActionLabel: '查看近期默认',
      secondaryActionKind: 'open-audit' as const,
      secondaryActionLabel: '查看近期默认变更',
      secondaryActionDisabled: false,
      actionNote: '该场景近期被提升为默认入口，建议先查看默认变更再继续扩散。',
    }
  }

  return {
    primaryActionKind: 'apply-scene' as const,
    primaryActionLabel: '查看最新更新',
    secondaryActionKind: 'open-audit' as const,
    secondaryActionLabel: '查看更新记录',
    secondaryActionDisabled: false,
    actionNote: '该场景因近期更新被推荐，建议先核对更新记录再决定是否复用。',
  }
}

function getEligibleWorkbenchScenes(
  views: PlmWorkbenchTeamView<'workbench'>[],
  ownerUserId?: string,
) {
  const normalizedOwnerUserId = ownerUserId?.trim() || ''

  return views
    .filter((view) => !view.isArchived)
    .filter((view) => !normalizedOwnerUserId || view.ownerUserId === normalizedOwnerUserId)
}

export function buildWorkbenchSceneCatalogOwnerOptions(
  views: PlmWorkbenchTeamView<'workbench'>[],
) {
  return Array.from(
    new Set(
      views
        .map((view) => view.ownerUserId.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function buildRecommendedWorkbenchScenes(
  views: PlmWorkbenchTeamView<'workbench'>[],
  options?: {
    ownerUserId?: string
    recommendationFilter?: PlmWorkbenchSceneRecommendationFilter
  },
): PlmRecommendedWorkbenchScene[] {
  const recommendationFilter = options?.recommendationFilter || ''

  return getEligibleWorkbenchScenes(views, options?.ownerUserId)
    .map((view) => ({
      view,
      recommendationReason: getRecommendationReason(view),
    }))
    .filter((entry) => !recommendationFilter || entry.recommendationReason === recommendationFilter)
    .sort((left, right) => {
      if (left.view.isDefault !== right.view.isDefault) {
        return Number(right.view.isDefault) - Number(left.view.isDefault)
      }

      const rightDefault = getSceneTimestamp(right.view.lastDefaultSetAt)
      const leftDefault = getSceneTimestamp(left.view.lastDefaultSetAt)
      if (rightDefault !== leftDefault) {
        return rightDefault - leftDefault
      }

      const rightUpdated = getSceneTimestamp(right.view.updatedAt || right.view.createdAt)
      const leftUpdated = getSceneTimestamp(left.view.updatedAt || left.view.createdAt)
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
        secondaryActionDisabled: recommendationActions.secondaryActionDisabled,
        actionNote: recommendationActions.actionNote,
        updatedAt: view.updatedAt,
      }
    })
}

export function buildWorkbenchSceneSummaryChips(
  views: PlmWorkbenchTeamView<'workbench'>[],
  options?: {
    ownerUserId?: string
    recommendationFilter?: PlmWorkbenchSceneRecommendationFilter
  },
): PlmWorkbenchSceneSummaryChip[] {
  const eligibleViews = getEligibleWorkbenchScenes(views, options?.ownerUserId)
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

export function buildWorkbenchSceneSummaryHint(
  chips: PlmWorkbenchSceneSummaryChip[],
): PlmWorkbenchSceneSummaryHint {
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
    description: WORKBENCH_SCENE_RECOMMENDATION_DESCRIPTIONS[activeChip.value] || WORKBENCH_SCENE_RECOMMENDATION_DESCRIPTIONS[''],
  }
}
