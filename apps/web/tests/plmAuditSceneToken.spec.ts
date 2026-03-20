import { describe, expect, it } from 'vitest'
import { buildPlmAuditSceneToken } from '../src/views/plmAuditSceneToken'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditSceneToken', () => {
  it('builds owner-active token with restore and clear actions', () => {
    expect(buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: 'owner-a',
      ownerContextActive: true,
      sceneQueryContextActive: false,
    }, tr)).toEqual({
      kind: 'owner',
      label: 'Owner context|Owner 上下文',
      value: 'owner-a',
      description: 'Audit is currently focused on owner-related activity for this scene.|当前审计正在聚焦这个场景的 owner 相关活动。',
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

  it('builds scene-active token with owner pivot and clear actions', () => {
    expect(buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: 'owner-a',
      ownerContextActive: false,
      sceneQueryContextActive: true,
    }, tr)).toEqual({
      kind: 'scene',
      label: 'Scene query|场景查询',
      value: 'scene-1',
      description: 'Audit is currently focused on the selected scene context.|当前审计正在聚焦所选场景上下文。',
      active: true,
      actions: [
        {
          kind: 'owner',
          label: 'Filter by owner|按 owner 筛选',
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

  it('builds inactive owner token with owner pivot and clear actions', () => {
    expect(buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: 'owner-a',
      ownerContextActive: false,
      sceneQueryContextActive: false,
    }, tr)).toEqual({
      kind: 'owner',
      label: 'Scene owner|场景 owner',
      value: 'owner-a',
      description: 'Use the owner as an audit shortcut for this recommended scene.|把这个推荐场景的 owner 作为审计快捷入口。',
      active: false,
      actions: [
        {
          kind: 'owner',
          label: 'Filter by owner|按 owner 筛选',
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

  it('builds scene-only token with clear action', () => {
    expect(buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: '',
      ownerContextActive: false,
      sceneQueryContextActive: false,
    }, tr)).toEqual({
      kind: 'scene',
      label: 'Scene query|场景查询',
      value: 'scene-1',
      description: 'Keep this audit view linked to the selected scene context.|让当前审计视图继续关联到所选场景上下文。',
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

  it('returns null without scene or owner context', () => {
    expect(buildPlmAuditSceneToken({
      sceneValue: '',
      ownerValue: '',
      ownerContextActive: false,
      sceneQueryContextActive: false,
    }, tr)).toBeNull()
  })
})
