export function shouldShowPlmAuditPersistentReturnToScene(options: {
  returnToPlmPath: string
  sceneContextVisible: boolean
}) {
  return Boolean(options.returnToPlmPath.trim()) && !options.sceneContextVisible
}
