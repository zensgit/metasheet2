import type { PlmAuditRouteState } from './plmAuditQueryState'
import type { PlmAuditSavedView } from './plmAuditSavedViews'
import { resolvePlmAuditCanonicalTeamViewRouteState } from './plmAuditTeamViewControlTarget'

export type PlmAuditSavedViewShareFollowupActionKind = 'promote-team' | 'promote-default' | 'dismiss'
export type PlmAuditSavedViewShareFollowupSource = 'shared-entry' | 'scene-context'

export type PlmAuditSavedViewShareFollowup = {
  savedViewId: string
  source: PlmAuditSavedViewShareFollowupSource
}

export function resolvePlmAuditSavedViewLocalSaveFollowupSource(options: {
  sharedEntryTeamViewId: string
  routeTeamViewId: string
  sceneContextActive: boolean
}): PlmAuditSavedViewShareFollowupSource | null {
  if (
    options.sharedEntryTeamViewId
    && options.sharedEntryTeamViewId === options.routeTeamViewId
  ) {
    return 'shared-entry'
  }

  return options.sceneContextActive ? 'scene-context' : null
}

export function resolvePlmAuditSavedViewLocalSaveState(options: {
  source: PlmAuditSavedViewShareFollowupSource | null
  currentState: PlmAuditRouteState
  canonicalRouteState: PlmAuditRouteState
}) {
  if (options.source === 'shared-entry') {
    return options.canonicalRouteState
  }

  if (options.source === 'scene-context') {
    return resolvePlmAuditCanonicalTeamViewRouteState({
      currentState: options.currentState,
      routeTeamViewId: options.canonicalRouteState.teamViewId,
    })
  }

  return options.currentState
}

export type PlmAuditSavedViewShareFollowupNotice = {
  sourceLabel: string
  title: string
  description: string
  actions: Array<{
    kind: PlmAuditSavedViewShareFollowupActionKind
    label: string
    emphasis: 'primary' | 'secondary'
  }>
}

export type PlmAuditSavedViewShareFollowupActionFeedback = {
  kind: 'error'
  message: string
}

export function buildPlmAuditSavedViewShareFollowupNotice(
  view: Pick<PlmAuditSavedView, 'id' | 'name'>,
  followup: PlmAuditSavedViewShareFollowup | null,
  tr: (en: string, zh: string) => string,
): PlmAuditSavedViewShareFollowupNotice | null {
  if (!followup || followup.savedViewId !== view.id) return null

  const fromSharedEntry = followup.source === 'shared-entry'

  return {
    sourceLabel: fromSharedEntry
      ? tr('Shared team view link', '团队视图分享链接')
      : tr('Scene save shortcut', '场景快捷保存'),
    title: fromSharedEntry
      ? tr('Shared audit setup saved locally.', '分享的审计配置已保存到本地。')
      : tr('Scene audit saved locally.', '场景审计已保存到本地。'),
    description: fromSharedEntry
      ? tr(
          `You can keep "${view.name}" as a personal saved view, or immediately promote it into the audit team views.`,
          `你可以将“${view.name}”继续保留为个人已保存视图，或立即将其提升到审计团队视图。`,
        )
      : tr(
          `You can keep "${view.name}" as a personal saved view, or immediately promote this scene-focused audit into the audit team views.`,
          `你可以将“${view.name}”继续保留为个人已保存视图，或立即将这个场景审计提升到审计团队视图。`,
        ),
    actions: [
      {
        kind: 'promote-team',
        label: tr('Save to team', '保存到团队'),
        emphasis: 'primary',
      },
      {
        kind: 'promote-default',
        label: tr('Save as default team view', '保存为团队默认视图'),
        emphasis: 'secondary',
      },
      {
        kind: 'dismiss',
        label: tr('Done', '完成'),
        emphasis: 'secondary',
      },
    ],
  }
}

export function resolvePlmAuditSavedViewShareFollowupRuntimeState(
  followup: PlmAuditSavedViewShareFollowup | null,
  savedViews: readonly Pick<PlmAuditSavedView, 'id'>[],
): {
  followup: PlmAuditSavedViewShareFollowup | null
  changed: boolean
} {
  if (!followup) {
    return {
      followup: null,
      changed: false,
    }
  }
  const view = savedViews.find((entry) => entry.id === followup.savedViewId) || null
  if (view) {
    return {
      followup,
      changed: false,
    }
  }
  return {
    followup: null,
    changed: true,
  }
}

export function resolvePlmAuditSavedViewShareFollowupActionFeedback(options: {
  actionKind: Exclude<PlmAuditSavedViewShareFollowupActionKind, 'dismiss'>
  followup: PlmAuditSavedViewShareFollowup | null | undefined
  target: Pick<PlmAuditSavedView, 'id' | 'name'> | null | undefined
  tr: (en: string, zh: string) => string
}): PlmAuditSavedViewShareFollowupActionFeedback | null {
  const followup = options.followup || null
  const target = options.target || null
  const { tr } = options

  if (!followup) {
    return {
      kind: 'error',
      message: tr('Current saved-view follow-up is unavailable.', '当前保存视图后续动作不可用。'),
    }
  }

  if (!target) {
    return {
      kind: 'error',
      message: followup.source === 'shared-entry'
        ? tr(
            'Saved view is no longer available. Save the shared audit setup locally again before promoting it.',
            '保存视图已不存在。请先重新将分享的审计配置保存到本地，再执行提升。',
          )
        : tr(
            'Saved view is no longer available. Save the scene audit locally again before promoting it.',
            '保存视图已不存在。请先重新将场景审计保存到本地，再执行提升。',
          ),
    }
  }

  return null
}
