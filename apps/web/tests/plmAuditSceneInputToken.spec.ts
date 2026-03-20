import { describe, expect, it } from 'vitest'
import { buildPlmAuditSceneInputToken } from '../src/views/plmAuditSceneInputToken'
import { buildPlmAuditSceneToken } from '../src/views/plmAuditSceneToken'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditSceneInputToken', () => {
  it('builds a locked owner input token when owner context is active', () => {
    const token = buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: 'owner-a',
      ownerContextActive: true,
      sceneQueryContextActive: false,
    }, tr)

    expect(buildPlmAuditSceneInputToken(token, tr)).toEqual({
      kind: 'owner',
      label: 'Owner context|Owner 上下文',
      value: 'owner-a',
      description: 'Search is currently locked to the selected scene owner context.|当前搜索已锁定到所选场景的 owner 上下文。',
      locked: true,
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

  it('builds a locked scene input token when scene query context is active', () => {
    const token = buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: 'owner-a',
      ownerContextActive: false,
      sceneQueryContextActive: true,
    }, tr)

    expect(buildPlmAuditSceneInputToken(token, tr)).toEqual({
      kind: 'scene',
      label: 'Scene query|场景查询',
      value: 'scene-1',
      description: 'Search is currently locked to the selected scene query.|当前搜索已锁定到所选场景查询。',
      locked: true,
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

  it('builds an unlocked owner input token when owner shortcut is available', () => {
    const token = buildPlmAuditSceneToken({
      sceneValue: 'scene-1',
      ownerValue: 'owner-a',
      ownerContextActive: false,
      sceneQueryContextActive: false,
    }, tr)

    expect(buildPlmAuditSceneInputToken(token, tr)).toEqual({
      kind: 'owner',
      label: 'Scene owner|场景 owner',
      value: 'owner-a',
      description: 'Use this token to pivot search to the scene owner when needed.|需要时可用这个 token 快速切到场景 owner 搜索。',
      locked: false,
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

  it('returns null without token input', () => {
    expect(buildPlmAuditSceneInputToken(null, tr)).toBeNull()
  })
})
