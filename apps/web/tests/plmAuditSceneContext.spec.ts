import { describe, expect, it } from 'vitest'
import { DEFAULT_PLM_AUDIT_ROUTE_STATE } from '../src/views/plmAuditQueryState'
import {
  buildPlmAuditSceneSavedViewState,
  buildPlmAuditSceneTeamViewState,
  buildPlmAuditSceneQueryValue,
  isPlmAuditSceneContextActive,
  isPlmAuditSceneQueryContextActive,
  isPlmAuditSceneOwnerContextActive,
  shouldTakeOverPlmAuditSceneContextOnRouteChange,
  withoutPlmAuditSceneContext,
  withPlmAuditSceneOwnerContext,
  withPlmAuditSceneQueryContext,
} from '../src/views/plmAuditSceneContext'

describe('plmAuditSceneContext', () => {
  it('prefers scene id when building the scene query value', () => {
    expect(buildPlmAuditSceneQueryValue({
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
    })).toBe('scene-1')

    expect(buildPlmAuditSceneQueryValue({
      sceneId: '',
      sceneName: '采购团队场景',
    })).toBe('采购团队场景')
  })

  it('switches to owner context without dropping scene metadata', () => {
    expect(withPlmAuditSceneOwnerContext({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 4,
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })).toMatchObject({
      page: 1,
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })
  })

  it('can restore the scene query after switching to owner context', () => {
    expect(withPlmAuditSceneQueryContext({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 2,
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'default',
      sceneRecommendationSourceLabel: '当前团队默认场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })).toMatchObject({
      page: 1,
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneRecommendationReason: 'default',
      sceneRecommendationSourceLabel: '当前团队默认场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })
  })

  it('normalizes saved scene views back to canonical scene state before storing them', () => {
    expect(buildPlmAuditSceneSavedViewState({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 3,
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })).toMatchObject({
      page: 1,
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })

    expect(buildPlmAuditSceneSavedViewState({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 5,
      q: 'supplier-42',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })).toMatchObject({
      page: 1,
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })

    expect(buildPlmAuditSceneSavedViewState({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 4,
      q: 'supplier-42',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: 'owner-b',
      sceneRecommendationReason: 'default',
      sceneRecommendationSourceLabel: '当前团队默认场景',
      returnToPlmPath: '/plm?sceneFocus=owner-b',
    })).toMatchObject({
      page: 1,
      q: 'owner-b',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: 'owner-b',
      sceneRecommendationReason: 'default',
      sceneRecommendationSourceLabel: '当前团队默认场景',
      returnToPlmPath: '/plm?sceneFocus=owner-b',
    })
  })

  it('normalizes saved scene team views back to canonical scene filters before storing them', () => {
    expect(buildPlmAuditSceneTeamViewState({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 4,
      q: 'supplier-42',
      actorId: 'user-9',
      kind: 'team-view',
      windowMinutes: 720,
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })).toEqual({
      page: 1,
      q: 'scene-1',
      actorId: 'user-9',
      kind: 'team-view',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 720,
    })

    expect(buildPlmAuditSceneTeamViewState({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      page: 6,
      q: 'supplier-42',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: 'owner-b',
      sceneRecommendationReason: 'default',
      sceneRecommendationSourceLabel: '当前团队默认场景',
      returnToPlmPath: '/plm?sceneFocus=owner-b',
    })).toEqual({
      page: 1,
      q: 'owner-b',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
    })
  })

  it('clears recommendation and return metadata together with the scene context', () => {
    expect(withoutPlmAuditSceneContext({
      ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })).toMatchObject({
      q: 'scene-1',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      sceneRecommendationReason: '',
      sceneRecommendationSourceLabel: '',
      returnToPlmPath: '',
    })
  })

  it('detects when owner context is active', () => {
    expect(isPlmAuditSceneOwnerContextActive({
      q: 'owner-a',
      sceneOwnerUserId: 'owner-a',
    })).toBe(true)

    expect(isPlmAuditSceneOwnerContextActive({
      q: 'scene-1',
      sceneOwnerUserId: 'owner-a',
    })).toBe(false)
  })

  it('detects when scene query context is active', () => {
    expect(isPlmAuditSceneQueryContextActive({
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
    })).toBe(true)

    expect(isPlmAuditSceneQueryContextActive({
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
    })).toBe(false)
  })

  it('detects when any scene context is active', () => {
    expect(isPlmAuditSceneContextActive({
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    })).toBe(true)

    expect(isPlmAuditSceneContextActive({
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    })).toBe(true)

    expect(isPlmAuditSceneContextActive({
      q: 'supplier-42',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    })).toBe(false)
  })

  it('detects when external route changes should trigger scene-context takeover cleanup', () => {
    expect(shouldTakeOverPlmAuditSceneContextOnRouteChange({
      previousState: {
        q: 'supplier-42',
        sceneId: 'scene-1',
        sceneName: '采购团队场景',
        sceneOwnerUserId: 'owner-a',
      },
      nextState: {
        q: 'scene-1',
        sceneId: 'scene-1',
        sceneName: '采购团队场景',
        sceneOwnerUserId: 'owner-a',
      },
    })).toBe(true)

    expect(shouldTakeOverPlmAuditSceneContextOnRouteChange({
      previousState: {
        q: 'owner-a',
        sceneId: 'scene-1',
        sceneName: '采购团队场景',
        sceneOwnerUserId: 'owner-a',
      },
      nextState: {
        q: 'scene-2',
        sceneId: 'scene-2',
        sceneName: '发货场景',
        sceneOwnerUserId: 'owner-a',
      },
    })).toBe(true)

    expect(shouldTakeOverPlmAuditSceneContextOnRouteChange({
      previousState: {
        q: 'scene-1',
        sceneId: 'scene-1',
        sceneName: '采购团队场景',
        sceneOwnerUserId: 'owner-a',
      },
      nextState: {
        q: 'scene-1',
        sceneId: 'scene-1',
        sceneName: '采购团队场景',
        sceneOwnerUserId: 'owner-a',
      },
    })).toBe(false)

    expect(shouldTakeOverPlmAuditSceneContextOnRouteChange({
      previousState: {
        q: 'scene-1',
        sceneId: 'scene-1',
        sceneName: '采购团队场景',
        sceneOwnerUserId: 'owner-a',
      },
      nextState: {
        q: 'supplier-42',
        sceneId: 'scene-1',
        sceneName: '采购团队场景',
        sceneOwnerUserId: 'owner-a',
      },
    })).toBe(false)
  })
})
