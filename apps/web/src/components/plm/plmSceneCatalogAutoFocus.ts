export type PlmSceneCatalogAutoFocusResolution = {
  targetSceneId: string
  shouldClear: boolean
}

export function resolvePlmSceneCatalogAutoFocus(
  sceneId: string,
  recommendedSceneIds: readonly string[],
  availableSceneIds: readonly string[],
): PlmSceneCatalogAutoFocusResolution {
  if (!sceneId) {
    return {
      targetSceneId: '',
      shouldClear: false,
    }
  }

  if (recommendedSceneIds.includes(sceneId)) {
    return {
      targetSceneId: sceneId,
      shouldClear: true,
    }
  }

  return {
    targetSceneId: '',
    shouldClear: availableSceneIds.length > 0,
  }
}
