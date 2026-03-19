import { describe, expect, it } from 'vitest'
import { buildPlmAuditSceneSummaryCard } from '../src/views/plmAuditSceneSummary'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditSceneSummary', () => {
  it('builds an owner-context summary card when owner filtering is active', () => {
    expect(buildPlmAuditSceneSummaryCard({
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      ownerContextActive: true,
      sceneQueryContextActive: false,
    }, tr)).toEqual({
      kind: 'owner',
      sourceLabel: 'Local context|本地上下文',
      label: 'Owner context|Owner 上下文',
      value: 'owner-a',
      description: 'Audit is currently focused on owner-related activity for this scene.|当前审计正在聚焦这个场景的 owner 相关活动。',
      action: 'scene',
      actionLabel: 'Restore scene query|恢复场景查询',
      active: true,
    })
  })

  it('builds an active scene-query card when scene context drives the current query', () => {
    expect(buildPlmAuditSceneSummaryCard({
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      ownerContextActive: false,
      sceneQueryContextActive: true,
    }, tr)).toEqual({
      kind: 'scene',
      sourceLabel: 'Local context|本地上下文',
      label: 'Scene query|场景查询',
      value: 'scene-1',
      description: 'Audit is currently focused on the selected scene context.|当前审计正在聚焦所选场景上下文。',
      action: 'owner',
      actionLabel: 'Filter by owner|按 owner 筛选',
      active: true,
    })
  })

  it('builds an owner shortcut card when owner context is available but inactive', () => {
    expect(buildPlmAuditSceneSummaryCard({
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      ownerContextActive: false,
      sceneQueryContextActive: false,
    }, tr)).toEqual({
      kind: 'owner',
      sourceLabel: 'Local context|本地上下文',
      label: 'Scene owner|场景 owner',
      value: 'owner-a',
      description: 'Use the owner as an audit shortcut for this recommended scene.|把这个推荐场景的 owner 作为审计快捷入口。',
      action: 'owner',
      actionLabel: 'Filter by owner|按 owner 筛选',
      active: false,
    })
  })

  it('falls back to a scene-query summary when no owner is present', () => {
    expect(buildPlmAuditSceneSummaryCard({
      sceneId: '',
      sceneName: '采购团队场景',
      sceneOwnerUserId: '',
      ownerContextActive: false,
      sceneQueryContextActive: true,
    }, tr)).toEqual({
      kind: 'scene',
      sourceLabel: 'Local context|本地上下文',
      label: 'Scene query|场景查询',
      value: '采购团队场景',
      description: 'Audit is currently focused on the selected scene context.|当前审计正在聚焦所选场景上下文。',
      action: null,
      actionLabel: '',
      active: true,
    })
  })

  it('returns null when there is no scene context', () => {
    expect(buildPlmAuditSceneSummaryCard({
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      ownerContextActive: false,
      sceneQueryContextActive: false,
    }, tr)).toBeNull()
  })
})
