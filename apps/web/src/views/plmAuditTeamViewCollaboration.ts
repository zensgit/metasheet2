import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'
import type { PlmAuditRouteState } from './plmAuditQueryState'
import type { PlmAuditSavedViewShareFollowupSource } from './plmAuditSavedViewShareFollowup'
import {
  resolveAuditTeamViewRecommendationFilter,
  type PlmRecommendedAuditTeamViewFilter,
} from './plmAuditTeamViewCatalog'

export type PlmAuditTeamViewCollaborationSource = 'recommendation' | 'saved-view-promotion' | 'scene-context'
export type PlmAuditTeamViewCollaborationActionKind = 'share' | 'set-default' | 'dismiss'
export type PlmAuditTeamViewCollaborationFollowupActionKind = 'set-default' | 'view-logs' | 'focus-source' | 'dismiss'
export type PlmAuditTeamViewCollaborationAttentionMode = 'managed-team-view' | 'source-share-followup'

export type PlmAuditTeamViewCollaborationDraft = {
  teamViewId: string
  teamViewName: string
  teamViewOwnerUserId: string
  focusTargetId: string
  statusMessage: string
  source: PlmAuditTeamViewCollaborationSource
  sourceSavedViewId: string | null
}

export type PlmAuditTeamViewCollaborationNotice = {
  sourceLabel: string
  title: string
  description: string
  actions: Array<{
    kind: PlmAuditTeamViewCollaborationActionKind
    label: string
    emphasis: 'primary' | 'secondary'
  }>
}

export type PlmAuditTeamViewCollaborationFollowup = {
  teamViewId: string
  source: PlmAuditTeamViewCollaborationSource
  action: 'share' | 'set-default'
  logsAnchorId: string
  sourceAnchorId: string
  sourceSavedViewId: string | null
}

export type PlmAuditTeamViewCollaborationFollowupNotice = {
  sourceLabel: string
  title: string
  description: string
  actions: Array<{
    kind: PlmAuditTeamViewCollaborationFollowupActionKind
    label: string
    emphasis: 'primary' | 'secondary'
  }>
}

export type PlmAuditTeamViewCollaborationActionOutcome = {
  statusMessage: string
  followup: PlmAuditTeamViewCollaborationFollowup | null
  scrollTargetId: string | null
}

export type PlmAuditTeamViewCollaborationHandoff = {
  selectedTeamViewId: string | null
  teamViewName: string | null
  teamViewOwnerUserId: string | null
  selectedIds: string[]
  focusedTeamViewId: string
  draft: PlmAuditTeamViewCollaborationDraft | null
  followup: PlmAuditTeamViewCollaborationFollowup | null
  scrollTargetId: string
  statusMessage: string
}

export type PlmAuditTeamViewCollaborationSourceFocusIntent = {
  anchorId: string
  focusedRecommendationTeamViewId: string | null
  focusedSavedViewId: string | null
  recommendationFilter: PlmRecommendedAuditTeamViewFilter | null
}

const PLM_AUDIT_TEAM_VIEW_COLLABORATION_LOGS_ANCHOR_ID = 'plm-audit-log-results'
const PLM_AUDIT_TEAM_VIEW_CONTROLS_ANCHOR_ID = 'plm-audit-team-view-controls'

export function buildPlmAuditSavedViewPromotionCollaborationDraft(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'name'>,
  followupSource: PlmAuditSavedViewShareFollowupSource | null | undefined,
  tr: (en: string, zh: string) => string,
) {
  return buildPlmAuditTeamViewCollaborationDraft(
    view,
    tr,
    followupSource === 'scene-context' ? 'scene-context' : 'saved-view-promotion',
    {
      sourceSavedViewId: view.id,
    },
  )
}

export function resolvePlmAuditTeamViewCollaborationSourceAnchorId(
  source: PlmAuditTeamViewCollaborationSource,
  options?: {
    sceneContextAvailable?: boolean
  },
) {
  if (source === 'saved-view-promotion') return 'plm-audit-saved-views'
  if (source === 'scene-context') {
    return options?.sceneContextAvailable === false
      ? PLM_AUDIT_TEAM_VIEW_CONTROLS_ANCHOR_ID
      : 'plm-audit-scene-context'
  }
  return 'plm-audit-recommended-team-views'
}

export function buildPlmAuditTeamViewCollaborationFollowup(
  viewId: string,
  source: PlmAuditTeamViewCollaborationSource,
  action: PlmAuditTeamViewCollaborationFollowup['action'],
  options?: {
    sceneContextAvailable?: boolean
    sourceSavedViewId?: string | null
  },
): PlmAuditTeamViewCollaborationFollowup {
  return {
    teamViewId: viewId,
    source,
    action,
    logsAnchorId: PLM_AUDIT_TEAM_VIEW_COLLABORATION_LOGS_ANCHOR_ID,
    sourceAnchorId: resolvePlmAuditTeamViewCollaborationSourceAnchorId(source, options),
    sourceSavedViewId: source === 'saved-view-promotion' ? options?.sourceSavedViewId || null : null,
  }
}

export function syncPlmAuditTeamViewCollaborationFollowupSourceAnchor(
  followup: PlmAuditTeamViewCollaborationFollowup | null,
  options?: {
    sceneContextAvailable?: boolean
  },
): PlmAuditTeamViewCollaborationFollowup | null {
  if (!followup || followup.source !== 'scene-context') return followup
  const sourceAnchorId = resolvePlmAuditTeamViewCollaborationSourceAnchorId('scene-context', options)
  if (followup.sourceAnchorId === sourceAnchorId) return followup
  return {
    ...followup,
    sourceAnchorId,
  }
}

function isSceneContextControlsFollowup(followup: PlmAuditTeamViewCollaborationFollowup) {
  return followup.source === 'scene-context'
    && followup.sourceAnchorId === PLM_AUDIT_TEAM_VIEW_CONTROLS_ANCHOR_ID
}

export function findPlmAuditTeamViewCollaborationFollowupView<T extends { id: string }>(
  views: readonly T[],
  followup: Pick<PlmAuditTeamViewCollaborationFollowup, 'teamViewId'> | null,
): T | null {
  if (!followup) return null
  return views.find((view) => view.id === followup.teamViewId) || null
}

export function buildPlmAuditTeamViewCollaborationSourceFocusIntent(
  followup: Pick<PlmAuditTeamViewCollaborationFollowup, 'source' | 'sourceAnchorId' | 'sourceSavedViewId'>,
  view?: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'isDefault' | 'lastDefaultSetAt'> | null,
): PlmAuditTeamViewCollaborationSourceFocusIntent {
  if (followup.source === 'recommendation' && view) {
    return {
      anchorId: followup.sourceAnchorId,
      focusedRecommendationTeamViewId: view.id,
      focusedSavedViewId: null,
      recommendationFilter: resolveAuditTeamViewRecommendationFilter(view),
    }
  }

  return {
    anchorId: followup.sourceAnchorId,
    focusedRecommendationTeamViewId: null,
    focusedSavedViewId: followup.source === 'saved-view-promotion'
      ? followup.sourceSavedViewId || null
      : null,
    recommendationFilter: null,
  }
}

export function buildPlmAuditTeamViewCollaborationActionStatus(
  source: PlmAuditTeamViewCollaborationSource,
  action: Exclude<PlmAuditTeamViewCollaborationActionKind, 'dismiss'>,
  tr: (en: string, zh: string) => string,
) {
  if (action === 'share') {
    if (source === 'scene-context') {
      return tr(
        'Share link copied for the scene-driven audit team view.',
        '已复制场景驱动审计团队视图的分享链接。',
      )
    }
    return source === 'saved-view-promotion'
      ? tr(
          'Share link copied for the promoted audit team view.',
          '已复制提升后的审计团队视图分享链接。',
        )
      : tr(
          'Share link copied for the recommended audit team view.',
          '已复制推荐审计团队视图的分享链接。',
      )
  }

  if (source === 'scene-context') {
    return tr(
      'Scene-driven audit team view set as default. Showing matching audit logs.',
      '场景驱动审计团队视图已设为默认，并切换到对应审计日志。',
    )
  }

  return source === 'saved-view-promotion'
    ? tr(
        'Promoted audit team view set as default. Showing matching audit logs.',
        '已将提升后的审计团队视图设为默认，并切换到对应审计日志。',
      )
    : tr(
        'Recommended audit team view set as default. Showing matching audit logs.',
        '已将推荐审计团队视图设为默认，并切换到对应审计日志。',
      )
}

export function buildPlmAuditTeamViewCollaborationActionOutcome(
  viewId: string,
  source: PlmAuditTeamViewCollaborationSource | null | undefined,
  action: Exclude<PlmAuditTeamViewCollaborationActionKind, 'dismiss'>,
  tr: (en: string, zh: string) => string,
  options?: {
    sceneContextAvailable?: boolean
    sourceSavedViewId?: string | null
  },
): PlmAuditTeamViewCollaborationActionOutcome {
  if (!source) {
    return {
      statusMessage: action === 'share'
        ? tr('Audit team view link copied.', '审计团队视图链接已复制。')
        : tr(
            'Audit team view set as default. Showing matching audit logs.',
            '审计团队视图已设为默认，已切换到对应审计日志。',
          ),
      followup: null,
      scrollTargetId: null,
    }
  }

  const followup = buildPlmAuditTeamViewCollaborationFollowup(
    viewId,
    source,
    action,
    options,
  )

  return {
    statusMessage: buildPlmAuditTeamViewCollaborationActionStatus(source, action, tr),
    followup,
    scrollTargetId: action === 'set-default' ? followup.logsAnchorId : null,
  }
}

export function resolvePlmAuditTeamViewCollaborationAttentionMode(
  source: PlmAuditTeamViewCollaborationSource | null | undefined,
  action: Exclude<PlmAuditTeamViewCollaborationActionKind, 'dismiss'>,
): PlmAuditTeamViewCollaborationAttentionMode {
  if (action === 'share' && source) {
    return 'source-share-followup'
  }
  return 'managed-team-view'
}

export function shouldKeepPlmAuditTeamViewCollaborationFollowup(
  followup: Pick<PlmAuditTeamViewCollaborationFollowup, 'action' | 'teamViewId'> | null,
  routeState: Pick<
    PlmAuditRouteState,
    'page' | 'teamViewId' | 'q' | 'actorId' | 'kind' | 'action' | 'resourceType' | 'from' | 'to'
  >,
) {
  if (!followup) return false
  if (followup.action === 'set-default') {
    const onDefaultLogRoute = routeState.page === 1
      && !routeState.actorId
      && routeState.kind === 'audit'
      && !routeState.from
      && !routeState.to
    return routeState.action === 'set-default'
      && routeState.resourceType === 'plm-team-view-default'
      && routeState.q === followup.teamViewId
      && onDefaultLogRoute
  }
  return routeState.teamViewId === followup.teamViewId
}

export function prunePlmAuditTeamViewCollaborationDraftSavedViewSource(
  draft: PlmAuditTeamViewCollaborationDraft | null,
  savedViewId: string,
): PlmAuditTeamViewCollaborationDraft | null {
  if (!draft || draft.sourceSavedViewId !== savedViewId) return draft
  return {
    ...draft,
    sourceSavedViewId: null,
  }
}

export function prunePlmAuditTeamViewCollaborationFollowupSavedViewSource(
  followup: PlmAuditTeamViewCollaborationFollowup | null,
  savedViewId: string,
): PlmAuditTeamViewCollaborationFollowup | null {
  if (!followup || followup.sourceSavedViewId !== savedViewId) return followup
  return {
    ...followup,
    sourceSavedViewId: null,
  }
}

export function shouldClearPlmAuditTeamViewCollaborationDraft(
  draft: Pick<PlmAuditTeamViewCollaborationDraft, 'teamViewId'> | null,
  viewId: string,
) {
  return draft?.teamViewId === viewId
}

export function shouldKeepPlmAuditTeamViewCollaborationDraft(
  draft: Pick<PlmAuditTeamViewCollaborationDraft, 'teamViewId'> | null,
  teamViewId: string,
) {
  return draft?.teamViewId === teamViewId
}

export function shouldClearPlmAuditTeamViewCollaborationFollowupForViewEntry(
  followup: Pick<PlmAuditTeamViewCollaborationFollowup, 'teamViewId'> | null,
  viewId: string,
) {
  return followup?.teamViewId === viewId
}

export function buildPlmAuditTeamViewCollaborationHandoff(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'name'>,
  options: {
    source: PlmAuditTeamViewCollaborationSource
    mode: 'draft' | 'set-default-followup'
    selectable: boolean
    sceneContextAvailable?: boolean
    statusSuffix?: string
    sourceSavedViewId?: string | null
  },
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewCollaborationHandoff {
  if (options.mode === 'draft') {
    const draft = buildPlmAuditTeamViewCollaborationDraft(view, tr, options.source, {
      sourceSavedViewId: options.sourceSavedViewId,
    })
    return {
      selectedTeamViewId: draft.teamViewId,
      teamViewName: draft.teamViewName,
      teamViewOwnerUserId: draft.teamViewOwnerUserId,
      selectedIds: options.selectable ? [view.id] : [],
      focusedTeamViewId: view.id,
      draft,
      followup: null,
      scrollTargetId: draft.focusTargetId,
      statusMessage: [draft.statusMessage, options.statusSuffix || ''].filter(Boolean).join(' '),
    }
  }

  const followup = buildPlmAuditTeamViewCollaborationFollowup(
    view.id,
    options.source,
    'set-default',
    {
      sceneContextAvailable: options.sceneContextAvailable,
      sourceSavedViewId: options.sourceSavedViewId,
    },
  )

  return {
    selectedTeamViewId: null,
    teamViewName: null,
    teamViewOwnerUserId: null,
    selectedIds: options.selectable ? [view.id] : [],
    focusedTeamViewId: view.id,
    draft: null,
    followup,
    scrollTargetId: followup.logsAnchorId,
    statusMessage: [
      buildPlmAuditTeamViewCollaborationActionStatus(options.source, 'set-default', tr),
      options.statusSuffix || '',
    ].filter(Boolean).join(' '),
  }
}

export function buildPlmAuditTeamViewCollaborationFollowupNotice(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'isDefault' | 'isArchived'>,
  followup: PlmAuditTeamViewCollaborationFollowup | null,
  options: {
    canSetDefault: boolean
  },
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewCollaborationFollowupNotice | null {
  if (!followup || followup.teamViewId !== view.id) return null

  if (followup.action === 'share') {
    const actions: PlmAuditTeamViewCollaborationFollowupNotice['actions'] = []
    if (options.canSetDefault && !view.isArchived && !view.isDefault) {
      actions.push({
        kind: 'set-default',
        label: tr('Set as default', '设为默认'),
        emphasis: 'primary',
      })
    }
    actions.push({
      kind: 'focus-source',
      label: followup.source === 'saved-view-promotion'
        ? tr('Back to saved views', '回到保存视图')
        : isSceneContextControlsFollowup(followup)
          ? tr('Back to team view controls', '回到团队视图控制区')
        : followup.source === 'scene-context'
          ? tr('Back to scene context', '回到场景上下文')
          : tr('Back to recommendations', '回到推荐卡片'),
      emphasis: 'secondary',
    })
    actions.push({
      kind: 'dismiss',
      label: tr('Done', '完成'),
      emphasis: 'secondary',
    })

    return {
      sourceLabel: followup.source === 'saved-view-promotion'
        ? tr('Saved view promotion', '保存视图提升')
        : followup.source === 'scene-context'
          ? tr('Scene save shortcut', '场景快捷保存')
          : tr('Recommended team view', '推荐团队视图'),
      title: tr('Share link copied.', '分享链接已复制。'),
      description: followup.source === 'saved-view-promotion'
        ? tr(
            'This share link came from the saved-view promotion flow. You can return to the saved-view list or continue by promoting this team view to the default audit entry.',
            '这条分享链接来自保存视图提升流程。你可以返回保存视图列表，或继续将该团队视图提升为默认审计入口。',
          )
        : isSceneContextControlsFollowup(followup)
          ? tr(
              'This share link came from the scene quick-save flow. You can jump back to the team-view controls or continue by promoting this team view to the default audit entry.',
              '这条分享链接来自场景快捷保存流程。你可以返回团队视图控制区，或继续将该团队视图提升为默认审计入口。',
            )
        : followup.source === 'scene-context'
          ? tr(
              'This share link came from the scene quick-save flow. You can jump back to the scene context or continue by promoting this team view to the default audit entry.',
              '这条分享链接来自场景快捷保存流程。你可以返回场景上下文，或继续将该团队视图提升为默认审计入口。',
            )
          : tr(
              'This share link came from a recommended team view card. You can jump back to recommendations or continue by promoting it to the default audit entry.',
              '这条分享链接来自推荐团队视图卡片。你可以返回推荐区域，或继续将其提升为默认审计入口。',
            ),
      actions,
    }
  }

  return {
    sourceLabel: followup.source === 'saved-view-promotion'
      ? tr('Saved view promotion', '保存视图提升')
      : followup.source === 'scene-context'
        ? tr('Scene save shortcut', '场景快捷保存')
        : tr('Recommended team view', '推荐团队视图'),
    title: tr('Default audit entry updated.', '默认审计入口已更新。'),
    description: tr(
      'Matching default-change audit logs are ready below. Review them now or dismiss this follow-up.',
      '对应的默认变更审计日志已在下方就绪。你可以立即查看，或关闭这条后续提示。',
    ),
    actions: [
      {
        kind: 'view-logs',
        label: tr('Review audit logs', '查看审计日志'),
        emphasis: 'primary',
      },
      {
        kind: 'dismiss',
        label: tr('Done', '完成'),
        emphasis: 'secondary',
      },
    ],
  }
}

export function buildPlmAuditTeamViewCollaborationDraft(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'name'>,
  tr: (en: string, zh: string) => string,
  source: PlmAuditTeamViewCollaborationSource = 'recommendation',
  options?: {
    sourceSavedViewId?: string | null
  },
): PlmAuditTeamViewCollaborationDraft {
  return {
    teamViewId: view.id,
    teamViewName: view.name,
    teamViewOwnerUserId: '',
    focusTargetId: 'plm-audit-team-view-controls',
    source,
    sourceSavedViewId: source === 'saved-view-promotion' ? options?.sourceSavedViewId || null : null,
    statusMessage: source === 'saved-view-promotion'
      ? tr(
          'Saved view promoted and collaboration controls are ready.',
          '保存视图已提升为团队视图，并已准备好协作操作。',
        )
      : source === 'scene-context'
        ? tr(
            'Scene audit saved to team views and collaboration controls are ready.',
            '场景审计已保存到团队视图，并已准备好协作操作。',
          )
      : tr(
          'Prepared collaboration controls for this audit team view.',
          '已为该审计团队视图准备好协作操作。',
        ),
  }
}

export function buildPlmAuditTeamViewCollaborationNotice(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'name' | 'isDefault' | 'isArchived'>,
  draft: PlmAuditTeamViewCollaborationDraft | null,
  options: {
    canShare: boolean
    canSetDefault: boolean
  },
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewCollaborationNotice | null {
  if (!draft || draft.teamViewId !== view.id) return null

  const actions: PlmAuditTeamViewCollaborationNotice['actions'] = []
  if (options.canShare && !view.isArchived) {
    actions.push({
      kind: 'share',
      label: tr('Copy share link', '复制分享链接'),
      emphasis: 'secondary',
    })
  }
  if (options.canSetDefault && !view.isArchived && !view.isDefault) {
    actions.push({
      kind: 'set-default',
      label: tr('Set as default', '设为默认'),
      emphasis: 'primary',
    })
  }
  actions.push({
    kind: 'dismiss',
    label: tr('Done', '完成'),
    emphasis: 'secondary',
  })

  return {
    sourceLabel: draft.source === 'saved-view-promotion'
      ? tr('Saved view promotion', '保存视图提升')
      : draft.source === 'scene-context'
        ? tr('Scene save shortcut', '场景快捷保存')
        : tr('Recommended team view', '推荐团队视图'),
    title: draft.source === 'saved-view-promotion'
      ? tr('The promoted team view is ready for collaboration.', '已提升的团队视图已可继续协作。')
      : draft.source === 'scene-context'
        ? tr('The scene-driven team view is ready for collaboration.', '场景驱动团队视图已可继续协作。')
      : tr('The recommended team view is ready for collaboration.', '推荐的团队视图已可继续协作。'),
    description: draft.source === 'saved-view-promotion'
      ? tr(
          'Typical next steps are sharing this team view or promoting it to the default team audit entry.',
          '常见下一步是分享这个团队视图，或继续提升为团队默认审计入口。',
        )
      : draft.source === 'scene-context'
        ? tr(
            'Typical next steps are sharing this scene-driven team view or promoting it to the default team audit entry.',
            '常见下一步是分享这个场景驱动团队视图，或继续提升为团队默认审计入口。',
          )
      : tr(
          'You can immediately share this recommended team view or promote it to the default audit entry.',
          '你可以立即分享这个推荐团队视图，或将其提升为默认审计入口。',
        ),
    actions,
  }
}
