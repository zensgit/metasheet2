import { describe, expect, it } from 'vitest'
import { buildPlmAuditSceneToken } from '../src/views/plmAuditSceneToken'
import { buildPlmAuditTeamViewContextNote } from '../src/views/plmAuditTeamViewContext'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditTeamViewContext', () => {
  it('builds a local-only note for active owner context', () => {
    const token = buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: 'owner-a',
      ownerContextActive: true,
      sceneQueryContextActive: false,
    }, tr)

    expect(buildPlmAuditTeamViewContextNote(token, tr)).toEqual({
      kind: 'owner',
      sourceLabel: 'Local-only context|仅本地上下文',
      label: 'Owner context|Owner 上下文',
      value: 'owner-a',
      description: 'This scene or owner context is local to the current audit session and is not persisted in team views.|这个场景或 owner 上下文只属于当前审计会话，不会持久化进团队视图。',
      localOnly: true,
      active: true,
      actions: [
        {
          kind: 'scene',
          label: 'Restore scene query|恢复场景查询',
          emphasis: 'primary',
        },
        {
          kind: 'clear',
          label: 'Clear context|清除上下文',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('builds a local-only note for inactive scene context', () => {
    const token = buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: '',
      ownerContextActive: false,
      sceneQueryContextActive: false,
    }, tr)

    expect(buildPlmAuditTeamViewContextNote(token, tr)).toEqual({
      kind: 'scene',
      sourceLabel: 'Local-only context|仅本地上下文',
      label: 'Scene query|场景查询',
      value: 'scene-1',
      description: 'This local context can be pivoted before applying or saving a team view, but team views still store route filters only.|这个本地上下文可在应用或保存团队视图前切换，但团队视图仍只保存路由过滤条件。',
      localOnly: true,
      active: false,
      actions: [
        {
          kind: 'clear',
          label: 'Clear context|清除上下文',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('returns null without scene token', () => {
    expect(buildPlmAuditTeamViewContextNote(null, tr)).toBeNull()
  })
})
