import {
  buildPlmAuditSceneInputDescription,
  resolvePlmAuditSceneSemanticFromToken,
} from './plmAuditSceneCopy'
import type { PlmAuditSceneToken } from './plmAuditSceneToken'

export type PlmAuditSceneInputToken = {
  kind: 'owner' | 'scene'
  label: string
  value: string
  description: string
  locked: boolean
  actions: PlmAuditSceneToken['actions']
}

export function buildPlmAuditSceneInputToken(
  token: PlmAuditSceneToken | null,
  tr: (en: string, zh: string) => string,
): PlmAuditSceneInputToken | null {
  if (!token) return null

  const semantic = resolvePlmAuditSceneSemanticFromToken(token)

  return {
    kind: token.kind,
    label: token.label,
    value: token.value,
    description: buildPlmAuditSceneInputDescription(semantic, tr),
    locked: token.active,
    actions: token.actions,
  }
}
