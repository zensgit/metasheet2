import { buildPlmAuditSceneQueryValue } from './plmAuditSceneContext'
import { buildPlmAuditSceneSourceCopy } from './plmAuditSceneCopy'
import { buildPlmAuditSceneToken } from './plmAuditSceneToken'

export type PlmAuditSceneSummaryCard = {
  kind: 'owner' | 'scene'
  sourceLabel: string
  label: string
  value: string
  description: string
  action: 'owner' | 'scene' | 'reapply-scene' | null
  actionLabel: string
  active: boolean
}

export type PlmAuditSceneSummaryInput = {
  sceneId: string
  sceneName: string
  sceneOwnerUserId: string
  ownerContextActive: boolean
  sceneQueryContextActive: boolean
}

export function buildPlmAuditSceneSummaryCard(
  input: PlmAuditSceneSummaryInput,
  tr: (en: string, zh: string) => string,
): PlmAuditSceneSummaryCard | null {
  const sceneValue = buildPlmAuditSceneQueryValue(input)
  const token = buildPlmAuditSceneToken({
    sceneValue,
    ownerValue: input.sceneOwnerUserId,
    ownerContextActive: input.ownerContextActive,
    sceneQueryContextActive: input.sceneQueryContextActive,
  }, tr)

  if (!token) return null

  const primaryAction = token.actions.find((item) => item.emphasis === 'primary') ?? null
  const shouldExposeSceneReapply = Boolean(sceneValue) && (
    token.kind === 'scene'
    || input.ownerContextActive
    || input.sceneQueryContextActive
  )

  return {
    kind: token.kind,
    sourceLabel: buildPlmAuditSceneSourceCopy('summary', tr).label,
    label: token.label,
    value: token.value,
    description: token.description,
    action: shouldExposeSceneReapply
      ? 'reapply-scene'
      : (primaryAction?.kind === 'clear' ? null : (primaryAction?.kind ?? null)),
    actionLabel: shouldExposeSceneReapply
      ? tr('Reapply scene filter', '重新应用场景过滤')
      : (primaryAction?.label ?? ''),
    active: token.active,
  }
}
