import {
  buildPlmAuditSceneActionLabel,
  buildPlmAuditSceneSemanticCopy,
  resolvePlmAuditSceneSemantic,
  type PlmAuditSceneActionKind,
} from './plmAuditSceneCopy'

export type PlmAuditSceneTokenActionKind = PlmAuditSceneActionKind

export type PlmAuditSceneTokenAction = {
  kind: PlmAuditSceneTokenActionKind
  label: string
  emphasis: 'primary' | 'secondary'
}

export type PlmAuditSceneToken = {
  kind: 'owner' | 'scene'
  label: string
  value: string
  description: string
  active: boolean
  actions: PlmAuditSceneTokenAction[]
}

export type PlmAuditSceneTokenInput = {
  sceneValue: string
  ownerValue: string
  ownerContextActive: boolean
  sceneQueryContextActive: boolean
}

export function buildPlmAuditSceneToken(
  input: PlmAuditSceneTokenInput,
  tr: (en: string, zh: string) => string,
): PlmAuditSceneToken | null {
  const semantic = resolvePlmAuditSceneSemantic(input)
  if (!semantic) return null

  const copy = buildPlmAuditSceneSemanticCopy(semantic, tr)

  const actions: PlmAuditSceneTokenAction[] = []
  if (semantic === 'owner-context' && input.sceneValue) {
    actions.push({
      kind: 'scene',
      label: buildPlmAuditSceneActionLabel('scene', tr),
      emphasis: 'primary',
    })
  }
  if ((semantic === 'scene-context' && input.ownerValue) || semantic === 'scene-owner') {
    actions.push({
      kind: 'owner',
      label: buildPlmAuditSceneActionLabel('owner', tr),
      emphasis: 'primary',
    })
  }
  actions.push({
    kind: 'clear',
    label: buildPlmAuditSceneActionLabel('clear', tr),
    emphasis: 'secondary',
  })

  return {
    kind: copy.kind,
    label: copy.label,
    value: copy.kind === 'owner' ? input.ownerValue : input.sceneValue,
    description: copy.description,
    active: copy.active,
    actions,
  }
}
