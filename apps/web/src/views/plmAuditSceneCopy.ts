export type PlmAuditSceneSurface = 'summary' | 'saved-view' | 'team-view'
export type PlmAuditSceneKind = 'owner' | 'scene'
export type PlmAuditSceneActionKind = 'owner' | 'scene' | 'reapply-scene' | 'clear'
export type PlmAuditSceneSemantic = 'owner-context' | 'scene-context' | 'scene-owner' | 'scene-query'

export type PlmAuditSceneSemanticInput = {
  sceneValue: string
  ownerValue: string
  ownerContextActive: boolean
  sceneQueryContextActive: boolean
}

export type PlmAuditSceneSemanticCopy = {
  kind: PlmAuditSceneKind
  label: string
  description: string
  active: boolean
}

export type PlmAuditSceneSourceCopy = {
  label: string
  description: string
}

export type PlmAuditSceneContextBannerInput = {
  sceneId: string
  sceneName: string
  sceneOwnerUserId: string
  action: string
  resourceType: string
  semantic: PlmAuditSceneSemantic | null
  recommendationReason: string
  recommendationSourceLabel: string
}

export type PlmAuditSceneContextBanner = {
  title: string
  sourceLabel: string
  description: string
  sceneId: string
  sceneName: string
  sceneOwnerUserId: string
}

export type PlmAuditSceneFilterHighlight = PlmAuditSceneSemanticCopy & {
  sourceLabel: string
  value: string
  actions: Array<{
    kind: PlmAuditSceneActionKind
    label: string
    emphasis: 'primary' | 'secondary'
  }>
}

export function resolvePlmAuditSceneSemantic(
  input: PlmAuditSceneSemanticInput,
): PlmAuditSceneSemantic | null {
  if (!input.sceneValue && !input.ownerValue) return null
  if (input.ownerContextActive && input.ownerValue) return 'owner-context'
  if (input.sceneQueryContextActive && input.sceneValue) return 'scene-context'
  if (input.ownerValue) return 'scene-owner'
  if (input.sceneValue) return 'scene-query'
  return null
}

export function resolvePlmAuditSceneSemanticFromToken(
  token: Pick<PlmAuditSceneSemanticCopy, 'kind' | 'active'>,
): PlmAuditSceneSemantic {
  if (token.kind === 'owner') {
    return token.active ? 'owner-context' : 'scene-owner'
  }
  return token.active ? 'scene-context' : 'scene-query'
}

export function buildPlmAuditSceneSemanticCopy(
  semantic: PlmAuditSceneSemantic,
  tr: (en: string, zh: string) => string,
): PlmAuditSceneSemanticCopy {
  switch (semantic) {
    case 'owner-context':
      return {
        kind: 'owner',
        label: tr('Owner context', 'Owner 上下文'),
        description: tr(
          'Audit is currently focused on owner-related activity for this scene.',
          '当前审计正在聚焦这个场景的 owner 相关活动。',
        ),
        active: true,
      }
    case 'scene-context':
      return {
        kind: 'scene',
        label: tr('Scene query', '场景查询'),
        description: tr(
          'Audit is currently focused on the selected scene context.',
          '当前审计正在聚焦所选场景上下文。',
        ),
        active: true,
      }
    case 'scene-owner':
      return {
        kind: 'owner',
        label: tr('Scene owner', '场景 owner'),
        description: tr(
          'Use the owner as an audit shortcut for this recommended scene.',
          '把这个推荐场景的 owner 作为审计快捷入口。',
        ),
        active: false,
      }
    case 'scene-query':
      return {
        kind: 'scene',
        label: tr('Scene query', '场景查询'),
        description: tr(
          'Keep this audit view linked to the selected scene context.',
          '让当前审计视图继续关联到所选场景上下文。',
        ),
        active: false,
      }
  }
}

export function buildPlmAuditSceneActionLabel(
  action: PlmAuditSceneActionKind,
  tr: (en: string, zh: string) => string,
) {
  switch (action) {
    case 'owner':
      return tr('Filter by owner', '按 owner 筛选')
    case 'scene':
      return tr('Restore scene query', '恢复场景查询')
    case 'reapply-scene':
      return tr('Reapply scene filter', '重新应用场景过滤')
    case 'clear':
      return tr('Clear context', '清除上下文')
  }
}

export function buildPlmAuditSceneActionHint(
  action: Exclude<PlmAuditSceneActionKind, 'clear'>,
  tr: (en: string, zh: string) => string,
) {
  if (action === 'owner') {
    return tr('Current audit is already filtered by this scene owner.', '当前审计已按这个场景的 owner 过滤。')
  }
  return tr('Current audit is already using this scene query.', '当前审计已使用这个场景查询。')
}

export function buildPlmAuditSceneInputDescription(
  semantic: PlmAuditSceneSemantic,
  tr: (en: string, zh: string) => string,
) {
  switch (semantic) {
    case 'owner-context':
      return tr(
        'Search is currently locked to the selected scene owner context.',
        '当前搜索已锁定到所选场景的 owner 上下文。',
      )
    case 'scene-context':
      return tr(
        'Search is currently locked to the selected scene query.',
        '当前搜索已锁定到所选场景查询。',
      )
    case 'scene-owner':
      return tr(
        'Use this token to pivot search to the scene owner when needed.',
        '需要时可用这个 token 快速切到场景 owner 搜索。',
      )
    case 'scene-query':
      return tr(
        'Use this token to restore the selected scene query context.',
        '可用这个 token 恢复所选场景查询上下文。',
      )
  }
}

export function buildPlmAuditSceneSourceCopy(
  surface: PlmAuditSceneSurface,
  tr: (en: string, zh: string) => string,
): PlmAuditSceneSourceCopy {
  if (surface === 'saved-view') {
    return {
      label: tr('Saved view context', '保存视图上下文'),
      description: tr(
        'This scene or owner context is stored with the local saved view.',
        '这个场景或 owner 上下文会随本地保存视图一起保存。',
      ),
    }
  }

  if (surface === 'team-view') {
    return {
      label: tr('Local-only context', '仅本地上下文'),
      description: tr(
        'This scene or owner context is local to the current audit session and is not persisted in team views.',
        '这个场景或 owner 上下文只属于当前审计会话，不会持久化进团队视图。',
      ),
    }
  }

  return {
    label: tr('Local context', '本地上下文'),
    description: tr(
      'This summary reflects the current local scene or owner context.',
      '这个汇总反映的是当前本地场景或 owner 上下文。',
    ),
  }
}

export function buildPlmAuditSceneContextBanner(
  input: PlmAuditSceneContextBannerInput,
  tr: (en: string, zh: string) => string,
): PlmAuditSceneContextBanner | null {
  if (!input.sceneId && !input.sceneName && !input.sceneOwnerUserId) return null

  let description = tr('Opened from a recommended team scene card.', '来自推荐团队场景卡片。')
  if (
    input.recommendationReason === 'default'
    || (input.action === 'set-default' && input.resourceType === 'plm-team-view-default')
  ) {
    description = tr('Opened from a recommended default-scene card.', '来自推荐团队默认场景卡片。')
  } else if (input.recommendationReason === 'recent-default') {
    description = tr(
      'Opened from a recently defaulted team scene recommendation.',
      '来自最近被设为团队默认的场景推荐。',
    )
  } else if (input.recommendationReason === 'recent-update') {
    description = tr(
      'Opened from a recently updated team scene recommendation.',
      '来自最近更新的团队场景推荐。',
    )
  } else if (input.semantic === 'owner-context') {
    description = tr('Showing owner-related audit context for this scene.', '当前正在查看这个场景的 owner 相关审计上下文。')
  }

  return {
    title: tr('Scene context', '场景上下文'),
    sourceLabel: input.recommendationSourceLabel || buildPlmAuditSceneSourceCopy('summary', tr).label,
    description,
    sceneId: input.sceneId,
    sceneName: input.sceneName,
    sceneOwnerUserId: input.sceneOwnerUserId,
  }
}

export function buildPlmAuditSceneFilterHighlight(
  token: {
    kind: PlmAuditSceneKind
    label: string
    value: string
    description: string
    active: boolean
    actions: Array<{
      kind: PlmAuditSceneActionKind
      label: string
      emphasis: 'primary' | 'secondary'
    }>
  } | null,
  tr: (en: string, zh: string) => string,
): PlmAuditSceneFilterHighlight | null {
  if (!token?.active) return null

  return {
    ...token,
    sourceLabel: buildPlmAuditSceneSourceCopy('summary', tr).label,
  }
}

export function buildPlmAuditTeamViewContextDescription(
  active: boolean,
  tr: (en: string, zh: string) => string,
) {
  return active
    ? buildPlmAuditSceneSourceCopy('team-view', tr).description
    : tr(
      'This local context can be pivoted before applying or saving a team view, but team views still store route filters only.',
      '这个本地上下文可在应用或保存团队视图前切换，但团队视图仍只保存路由过滤条件。',
    )
}
