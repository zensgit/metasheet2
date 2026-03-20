import { buildPlmAuditSceneQueryValue } from './plmAuditSceneContext'
import { buildPlmAuditSceneSourceCopy } from './plmAuditSceneCopy'
import { buildPlmAuditSceneToken } from './plmAuditSceneToken'

export type PlmAuditSceneSummaryCard = {
  kind: 'owner' | 'scene'
  sourceLabel: string
  label: string
  value: string
  description: string
  action: 'owner' | 'scene' | null
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
  const token = buildPlmAuditSceneToken({
    sceneValue: buildPlmAuditSceneQueryValue(input),
    ownerValue: input.sceneOwnerUserId,
    ownerContextActive: input.ownerContextActive,
    sceneQueryContextActive: input.sceneQueryContextActive,
  }, tr)

  if (!token) return null

  const primaryAction = token.actions.find((item) => item.emphasis === 'primary') ?? null

  return {
    kind: token.kind,
    sourceLabel: buildPlmAuditSceneSourceCopy('summary', tr).label,
    label: token.label,
    value: token.value,
    description: token.description,
    action: primaryAction?.kind === 'clear' ? null : (primaryAction?.kind ?? null),
    actionLabel: primaryAction?.label ?? '',
    active: token.active,
  }
}
