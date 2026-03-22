import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditSavedViewTeamPromotionDraft,
  shouldFocusPlmAuditSavedViewPromotionRecommendation,
} from '../src/views/plmAuditSavedViewPromotion'
import type { PlmAuditSavedView } from '../src/views/plmAuditSavedViews'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

const sampleView: PlmAuditSavedView = {
  id: 'saved-1',
  name: 'Owner-focused audit',
  updatedAt: '2026-03-19T12:00:00.000Z',
  state: {
    page: 2,
    q: 'owner-a',
    actorId: 'auditor-1',
    kind: 'workbench',
    action: 'set-default',
    resourceType: 'plm-team-view-default',
    from: '2026-03-19T10:00:00.000Z',
    to: '2026-03-19T12:00:00.000Z',
    windowMinutes: 180,
    teamViewId: '',
    sceneId: 'scene-1',
    sceneName: '采购团队场景',
    sceneOwnerUserId: 'owner-a',
    sceneRecommendationReason: 'default',
    sceneRecommendationSourceLabel: '当前团队默认场景',
    returnToPlmPath: '/plm?sceneFocus=scene-1',
  },
}

describe('plmAuditSavedViewPromotion', () => {
  it('builds a team-view draft and strips local scene context from the saved state', () => {
    expect(buildPlmAuditSavedViewTeamPromotionDraft(sampleView, tr)).toEqual({
      name: 'Owner-focused audit',
      state: {
        page: 2,
        q: 'owner-a',
        actorId: 'auditor-1',
        kind: 'workbench',
        action: 'set-default',
        resourceType: 'plm-team-view-default',
        from: '2026-03-19T10:00:00.000Z',
        to: '2026-03-19T12:00:00.000Z',
        windowMinutes: 180,
      },
      localContextNote:
        'This scene or owner context is local to the current audit session and is not persisted in team views.|这个场景或 owner 上下文只属于当前审计会话，不会持久化进团队视图。',
    })
  })

  it('omits the local-context note when the saved view has no scene metadata', () => {
    expect(buildPlmAuditSavedViewTeamPromotionDraft({
      ...sampleView,
      state: {
        ...sampleView.state,
        sceneId: '',
        sceneName: '',
        sceneOwnerUserId: '',
      },
    }, tr).localContextNote).toBe('')
  })

  it('only hands off saved-view promotion into recommendations for shared-link follow-ups', () => {
    expect(shouldFocusPlmAuditSavedViewPromotionRecommendation('shared-entry')).toBe(true)
    expect(shouldFocusPlmAuditSavedViewPromotionRecommendation('scene-context')).toBe(false)
    expect(shouldFocusPlmAuditSavedViewPromotionRecommendation(null)).toBe(false)
  })
})
