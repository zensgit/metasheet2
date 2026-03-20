import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditSceneActionHint,
  buildPlmAuditSceneActionLabel,
  buildPlmAuditSceneContextBanner,
  buildPlmAuditSceneFilterHighlight,
  buildPlmAuditSceneInputDescription,
  buildPlmAuditSceneSemanticCopy,
  buildPlmAuditTeamViewContextDescription,
  resolvePlmAuditSceneSemantic,
  resolvePlmAuditSceneSemanticFromToken,
} from '../src/views/plmAuditSceneCopy'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditSceneCopy', () => {
  it('resolves semantic from route state shape', () => {
    expect(resolvePlmAuditSceneSemantic({
      sceneValue: 'scene-1',
      ownerValue: 'owner-a',
      ownerContextActive: true,
      sceneQueryContextActive: false,
    })).toBe('owner-context')
    expect(resolvePlmAuditSceneSemantic({
      sceneValue: 'scene-1',
      ownerValue: '',
      ownerContextActive: false,
      sceneQueryContextActive: false,
    })).toBe('scene-query')
  })

  it('resolves semantic from token shape', () => {
    expect(resolvePlmAuditSceneSemanticFromToken({ kind: 'owner', active: false })).toBe('scene-owner')
    expect(resolvePlmAuditSceneSemanticFromToken({ kind: 'scene', active: true })).toBe('scene-context')
  })

  it('builds semantic copy and input description from the same contract', () => {
    expect(buildPlmAuditSceneSemanticCopy('scene-owner', tr)).toEqual({
      kind: 'owner',
      label: 'Scene owner|场景 owner',
      description: 'Use the owner as an audit shortcut for this recommended scene.|把这个推荐场景的 owner 作为审计快捷入口。',
      active: false,
    })
    expect(buildPlmAuditSceneInputDescription('scene-owner', tr)).toBe(
      'Use this token to pivot search to the scene owner when needed.|需要时可用这个 token 快速切到场景 owner 搜索。',
    )
  })

  it('builds action labels and hints from the same contract', () => {
    expect(buildPlmAuditSceneActionLabel('scene', tr)).toBe('Restore scene query|恢复场景查询')
    expect(buildPlmAuditSceneActionLabel('clear', tr)).toBe('Clear context|清除上下文')
    expect(buildPlmAuditSceneActionHint('owner', tr)).toBe(
      'Current audit is already filtered by this scene owner.|当前审计已按这个场景的 owner 过滤。',
    )
  })

  it('builds team-view descriptions from the shared contract', () => {
    expect(buildPlmAuditTeamViewContextDescription(true, tr)).toBe(
      'This scene or owner context is local to the current audit session and is not persisted in team views.|这个场景或 owner 上下文只属于当前审计会话，不会持久化进团队视图。',
    )
    expect(buildPlmAuditTeamViewContextDescription(false, tr)).toBe(
      'This local context can be pivoted before applying or saving a team view, but team views still store route filters only.|这个本地上下文可在应用或保存团队视图前切换，但团队视图仍只保存路由过滤条件。',
    )
  })

  it('builds context banner copy from the shared contract', () => {
    expect(buildPlmAuditSceneContextBanner({
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      semantic: 'owner-context',
    }, tr)).toEqual({
      title: 'Scene context|场景上下文',
      sourceLabel: 'Local context|本地上下文',
      description: 'Opened from a recommended default-scene card.|来自推荐团队默认场景卡片。',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    })
  })

  it('builds filter highlight copy from the shared contract', () => {
    expect(buildPlmAuditSceneFilterHighlight({
      kind: 'owner',
      label: 'Owner context|Owner 上下文',
      value: 'owner-a',
      description: 'Audit is currently focused on owner-related activity for this scene.|当前审计正在聚焦这个场景的 owner 相关活动。',
      active: true,
      actions: [
        { kind: 'scene', label: 'Restore scene query|恢复场景查询', emphasis: 'primary' },
        { kind: 'clear', label: 'Clear context|清除上下文', emphasis: 'secondary' },
      ],
    }, tr)).toEqual({
      kind: 'owner',
      sourceLabel: 'Local context|本地上下文',
      label: 'Owner context|Owner 上下文',
      value: 'owner-a',
      description: 'Audit is currently focused on owner-related activity for this scene.|当前审计正在聚焦这个场景的 owner 相关活动。',
      active: true,
      actions: [
        { kind: 'scene', label: 'Restore scene query|恢复场景查询', emphasis: 'primary' },
        { kind: 'clear', label: 'Clear context|清除上下文', emphasis: 'secondary' },
      ],
    })
  })
})
