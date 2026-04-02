import {
  buildPlmAuditSceneActionLabel,
  buildPlmAuditSceneSourceCopy,
  buildPlmAuditTeamViewContextDescription,
} from './plmAuditSceneCopy'
import type { PlmAuditSceneToken } from './plmAuditSceneToken'

export type PlmAuditTeamViewContextNote = {
  kind: 'owner' | 'scene'
  sourceLabel: string
  label: string
  value: string
  description: string
  localOnly: boolean
  active: boolean
  actions: PlmAuditSceneToken['actions']
}

export function buildPlmAuditTeamViewContextNote(
  token: PlmAuditSceneToken | null,
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewContextNote | null {
  if (!token) return null

  const shouldExposeSceneReapply = token.kind === 'scene' || (token.kind === 'owner' && token.active)
  const actions = shouldExposeSceneReapply
    ? [
      {
        kind: 'reapply-scene' as const,
        label: buildPlmAuditSceneActionLabel('reapply-scene', tr),
        emphasis: 'primary' as const,
      },
      ...token.actions.filter((item) => item.kind === 'clear'),
    ]
    : token.actions

  return {
    kind: token.kind,
    sourceLabel: buildPlmAuditSceneSourceCopy('team-view', tr).label,
    label: token.label,
    value: token.value,
    description: buildPlmAuditTeamViewContextDescription(token.active, tr),
    localOnly: true,
    active: token.active,
    actions,
  }
}
