import {
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

  return {
    kind: token.kind,
    sourceLabel: buildPlmAuditSceneSourceCopy('team-view', tr).label,
    label: token.label,
    value: token.value,
    description: buildPlmAuditTeamViewContextDescription(token.active, tr),
    localOnly: true,
    active: token.active,
    actions: token.actions,
  }
}
