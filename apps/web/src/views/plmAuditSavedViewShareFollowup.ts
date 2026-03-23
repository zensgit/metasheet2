import type { PlmAuditRouteState } from './plmAuditQueryState'
import type { PlmAuditSavedView } from './plmAuditSavedViews'

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
