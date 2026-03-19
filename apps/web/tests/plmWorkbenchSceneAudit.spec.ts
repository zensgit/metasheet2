import { describe, expect, it } from 'vitest'
import {
  buildRecommendedWorkbenchSceneAuditQuery,
  buildRecommendedWorkbenchSceneAuditState,
} from '../src/views/plm/plmWorkbenchSceneAudit'
import type { PlmRecommendedWorkbenchScene } from '../src/views/plm/plmPanelModels'

function createScene(
  overrides: Partial<PlmRecommendedWorkbenchScene>,
): PlmRecommendedWorkbenchScene {
  return {
    id: 'scene-1',
    name: '采购团队场景',
    ownerUserId: 'owner-a',
    isDefault: false,
    recommendationReason: 'recent-update',
    recommendationSourceLabel: '近期更新的团队场景',
    primaryActionLabel: '查看最新更新',
    secondaryActionLabel: '查看最近更新',
    updatedAt: '2026-03-19T08:00:00.000Z',
    ...overrides,
  }
}

describe('plmWorkbenchSceneAudit', () => {
  it('builds default-scene audit state for current defaults', () => {
    const state = buildRecommendedWorkbenchSceneAuditState(createScene({
      recommendationReason: 'default',
      isDefault: true,
      lastDefaultSetAt: '2026-03-19T10:00:00.000Z',
    }))

    expect(state).toEqual({
      page: 1,
      q: 'scene-1',
      actorId: '',
      kind: 'workbench',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      from: '',
      to: '',
      windowMinutes: 180,
      teamViewId: '',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    })
  })

  it('builds default-change audit query for recent defaults', () => {
    expect(buildRecommendedWorkbenchSceneAuditQuery(createScene({
      recommendationReason: 'recent-default',
      secondaryActionLabel: '查看近期默认变更',
      recommendationSourceLabel: '近期被设为团队默认场景',
      lastDefaultSetAt: '2026-03-19T09:00:00.000Z',
    }))).toEqual({
      auditQ: 'scene-1',
      auditKind: 'workbench',
      auditAction: 'set-default',
      auditType: 'plm-team-view-default',
      auditSceneId: 'scene-1',
      auditSceneName: '采购团队场景',
      auditSceneOwner: 'owner-a',
    })
  })

  it('builds generic workbench audit query for recent updates', () => {
    expect(buildRecommendedWorkbenchSceneAuditQuery(createScene({
      recommendationReason: 'recent-update',
    }))).toEqual({
      auditQ: 'scene-1',
      auditKind: 'workbench',
      auditSceneId: 'scene-1',
      auditSceneName: '采购团队场景',
      auditSceneOwner: 'owner-a',
    })
  })
})
