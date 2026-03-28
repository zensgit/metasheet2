import {
  buildPlmAuditSceneQueryValue,
  isPlmAuditSceneOwnerContextActive,
  isPlmAuditSceneQueryContextActive,
  withPlmAuditSceneOwnerContext,
  withPlmAuditSceneQueryContext,
} from './plmAuditSceneContext'
import {
  buildPlmAuditSceneActionHint,
  buildPlmAuditSceneActionLabel,
  buildPlmAuditSceneSourceCopy,
} from './plmAuditSceneCopy'
import type { PlmAuditRouteState } from './plmAuditQueryState'
import { buildPlmAuditSceneToken } from './plmAuditSceneToken'
import type { PlmAuditSceneTokenActionKind } from './plmAuditSceneToken'

export type PlmAuditSavedViewContextBadge = {
  kind: 'owner' | 'scene'
  sourceLabel: string
  label: string
  value: string
  active: boolean
  quickAction: {
    kind: Exclude<PlmAuditSceneTokenActionKind, 'clear'>
    label: string
    disabled: boolean
    hint: string
  } | null
}

export type PlmAuditSavedViewContextActionFeedback = {
  kind: 'error'
  message: string
}

function isSameSceneContextTarget(
  left: Pick<PlmAuditRouteState, 'q' | 'sceneId' | 'sceneName' | 'sceneOwnerUserId'>,
  right: Pick<PlmAuditRouteState, 'q' | 'sceneId' | 'sceneName' | 'sceneOwnerUserId'>,
) {
  return left.q === right.q
    && left.sceneId === right.sceneId
    && left.sceneName === right.sceneName
    && left.sceneOwnerUserId === right.sceneOwnerUserId
}

export function buildPlmAuditSavedViewContextBadge(
  state: PlmAuditRouteState,
  tr: (en: string, zh: string) => string,
  currentState?: Pick<PlmAuditRouteState, 'q' | 'sceneId' | 'sceneName' | 'sceneOwnerUserId'>,
): PlmAuditSavedViewContextBadge | null {
  const sceneValue = buildPlmAuditSceneQueryValue(state)
  const token = buildPlmAuditSceneToken({
    sceneValue,
    ownerValue: state.sceneOwnerUserId,
    ownerContextActive: isPlmAuditSceneOwnerContextActive(state),
    sceneQueryContextActive: isPlmAuditSceneQueryContextActive(state),
  }, tr)

  if (!token) return null

  const primaryAction = token.actions.find((item) => item.emphasis === 'primary' && item.kind !== 'clear') ?? null
  const ownerTarget = withPlmAuditSceneOwnerContext(state)
  const sceneTarget = withPlmAuditSceneQueryContext(state)
  const shouldExposeSceneReapply = Boolean(sceneValue) && (
    token.kind === 'scene'
    || isPlmAuditSceneOwnerContextActive(state)
    || isPlmAuditSceneQueryContextActive(state)
  )
  const quickAction = shouldExposeSceneReapply
    ? {
      kind: 'reapply-scene' as const,
      label: buildPlmAuditSceneActionLabel('reapply-scene', tr),
      disabled: Boolean(currentState && isSameSceneContextTarget(currentState, sceneTarget)),
      hint: buildPlmAuditSceneActionHint('reapply-scene', tr),
    }
    : (primaryAction && primaryAction.kind !== 'clear'
      ? {
        kind: primaryAction.kind,
        label: primaryAction.label,
        disabled:
          primaryAction.kind === 'owner'
            ? Boolean(currentState && isSameSceneContextTarget(currentState, ownerTarget))
            : Boolean(currentState && isSameSceneContextTarget(currentState, sceneTarget)),
        hint:
          buildPlmAuditSceneActionHint(primaryAction.kind, tr),
      }
      : null)

  return {
    kind: token.kind,
    sourceLabel: buildPlmAuditSceneSourceCopy('saved-view', tr).label,
    label: token.label,
    value: token.value,
    active: token.active,
    quickAction,
  }
}

export function resolvePlmAuditSavedViewContextActionFeedback(options: {
  badge: PlmAuditSavedViewContextBadge | null | undefined
  tr: (en: string, zh: string) => string
}): PlmAuditSavedViewContextActionFeedback | null {
  const badge = options.badge || null
  const { tr } = options
  if (!badge?.quickAction) {
    return {
      kind: 'error',
      message: tr('Current saved view context action is unavailable.', '当前保存视图上下文动作不可用。'),
    }
  }
  if (!badge.quickAction.disabled) {
    return null
  }
  return {
    kind: 'error',
    message: badge.quickAction.hint,
  }
}

export function buildPlmAuditSavedViewSummary(
  state: PlmAuditRouteState,
  tr: (en: string, zh: string) => string,
  actionLabel: (value: string) => string,
  resourceTypeLabel: (value: string) => string,
) {
  const segments: string[] = []
  if (state.sceneName) segments.push(`${tr('Scene', '场景')}: ${state.sceneName}`)
  if (state.sceneOwnerUserId) segments.push(`Owner: ${state.sceneOwnerUserId}`)
  if (state.q) segments.push(`${tr('Query', '查询')}: ${state.q}`)
  if (state.actorId) segments.push(`${tr('Actor', '操作者')}: ${state.actorId}`)
  if (state.kind) segments.push(`${tr('Kind', '类型')}: ${state.kind}`)
  if (state.action) segments.push(`${tr('Action', '动作')}: ${actionLabel(state.action)}`)
  if (state.resourceType) segments.push(`${tr('Resource', '资源')}: ${resourceTypeLabel(state.resourceType)}`)
  segments.push(`${tr('Window', '窗口')}: ${state.windowMinutes} ${tr('minutes', '分钟')}`)
  return segments.join(' · ') || tr('Default audit scope', '默认审计范围')
}
