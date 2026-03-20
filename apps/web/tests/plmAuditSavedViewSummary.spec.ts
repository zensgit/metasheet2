import { describe, expect, it } from 'vitest'
import type { PlmAuditRouteState } from '../src/views/plmAuditQueryState'
import {
  buildPlmAuditSavedViewContextBadge,
  buildPlmAuditSavedViewSummary,
} from '../src/views/plmAuditSavedViewSummary'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

const sampleState: PlmAuditRouteState = {
  page: 1,
  q: '',
  actorId: '',
  kind: 'workbench',
  action: 'set-default',
  resourceType: 'plm-team-view-default',
  from: '',
  to: '',
  windowMinutes: 180,
  teamViewId: '',
  sceneId: '',
  sceneName: '',
  sceneOwnerUserId: '',
}

describe('plmAuditSavedViewSummary', () => {
  it('builds an owner-context badge when q is locked to the owner', () => {
    expect(buildPlmAuditSavedViewContextBadge({
      ...sampleState,
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    }, tr)).toEqual({
      kind: 'owner',
      sourceLabel: 'Saved view context|保存视图上下文',
      label: 'Owner context|Owner 上下文',
      value: 'owner-a',
      active: true,
      quickAction: {
        kind: 'scene',
        label: 'Restore scene query|恢复场景查询',
        disabled: false,
        hint: 'Current audit is already using this scene query.|当前审计已使用这个场景查询。',
      },
    })
  })

  it('builds a scene-context badge when q is locked to the scene query', () => {
    expect(buildPlmAuditSavedViewContextBadge({
      ...sampleState,
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    }, tr)).toEqual({
      kind: 'scene',
      sourceLabel: 'Saved view context|保存视图上下文',
      label: 'Scene query|场景查询',
      value: 'scene-1',
      active: true,
      quickAction: {
        kind: 'owner',
        label: 'Filter by owner|按 owner 筛选',
        disabled: false,
        hint: 'Current audit is already filtered by this scene owner.|当前审计已按这个场景的 owner 过滤。',
      },
    })
  })

  it('builds an owner shortcut badge with owner quick action when context is available but inactive', () => {
    expect(buildPlmAuditSavedViewContextBadge({
      ...sampleState,
      q: 'documents',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    }, tr)).toEqual({
      kind: 'owner',
      sourceLabel: 'Saved view context|保存视图上下文',
      label: 'Scene owner|场景 owner',
      value: 'owner-a',
      active: false,
      quickAction: {
        kind: 'owner',
        label: 'Filter by owner|按 owner 筛选',
        disabled: false,
        hint: 'Current audit is already filtered by this scene owner.|当前审计已按这个场景的 owner 过滤。',
      },
    })
  })

  it('marks the quick action as disabled when current audit already matches the target context', () => {
    expect(buildPlmAuditSavedViewContextBadge({
      ...sampleState,
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    }, tr, {
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    })).toEqual({
      kind: 'scene',
      sourceLabel: 'Saved view context|保存视图上下文',
      label: 'Scene query|场景查询',
      value: 'scene-1',
      active: true,
      quickAction: {
        kind: 'owner',
        label: 'Filter by owner|按 owner 筛选',
        disabled: true,
        hint: 'Current audit is already filtered by this scene owner.|当前审计已按这个场景的 owner 过滤。',
      },
    })
  })

  it('builds a summary string that keeps scene and owner details', () => {
    expect(buildPlmAuditSavedViewSummary({
      ...sampleState,
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    }, tr, (value) => value, (value) => value)).toContain('Scene|场景: 采购团队场景')
  })
})
