export type PlmAuditSceneSaveDraft = {
  savedViewName: string
  teamViewName: string
  description: string
}

export type PlmAuditSceneSaveDraftInput = {
  sceneId: string
  sceneName: string
  sceneOwnerUserId: string
  recommendationReason: string
}

function resolveSceneLabel(input: PlmAuditSceneSaveDraftInput) {
  return input.sceneName || input.sceneId || input.sceneOwnerUserId || ''
}

function buildSavedViewSuffix(
  recommendationReason: string,
  tr: (en: string, zh: string) => string,
) {
  if (recommendationReason === 'default') {
    return tr('default audit scene', '默认审计场景')
  }
  if (recommendationReason === 'recent-default') {
    return tr('recent-default audit scene', '近期默认审计场景')
  }
  if (recommendationReason === 'recent-update') {
    return tr('recent-update audit scene', '近期更新审计场景')
  }
  return tr('audit scene', '审计场景')
}

export function buildPlmAuditSceneSaveDraft(
  input: PlmAuditSceneSaveDraftInput,
  tr: (en: string, zh: string) => string,
): PlmAuditSceneSaveDraft | null {
  const sceneLabel = resolveSceneLabel(input).trim()
  if (!sceneLabel) return null

  return {
    savedViewName: `${sceneLabel} · ${buildSavedViewSuffix(input.recommendationReason, tr)}`,
    teamViewName: `${sceneLabel} · ${tr('audit team scene', '审计团队场景')}`,
    description: tr(
      'Quick-save this scene-focused audit as a local view or promote it directly into team views.',
      '可将这个以场景为中心的审计快速保存为本地视图，或直接提升为团队视图。',
    ),
  }
}
