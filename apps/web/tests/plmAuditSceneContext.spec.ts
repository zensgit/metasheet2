import { describe, expect, it } from 'vitest'
import { DEFAULT_PLM_AUDIT_ROUTE_STATE } from '../src/views/plmAuditQueryState'
import {
  buildPlmAuditSceneQueryValue,
  isPlmAuditSceneQueryContextActive,
  isPlmAuditSceneOwnerContextActive,
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
    })).toMatchObject({
      page: 1,
      q: 'owner-a',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
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
    })).toMatchObject({
      page: 1,
      q: 'scene-1',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
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
})
