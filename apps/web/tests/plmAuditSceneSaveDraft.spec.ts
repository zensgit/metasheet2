import { describe, expect, it } from 'vitest'
import { buildPlmAuditSceneSaveDraft } from '../src/views/plmAuditSceneSaveDraft'

function tr(en: string, _zh: string) {
  return en
}

describe('plmAuditSceneSaveDraft', () => {
  it('builds default-scene save names', () => {
    expect(buildPlmAuditSceneSaveDraft({
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      recommendationReason: 'default',
    }, tr)).toEqual({
      savedViewName: '采购团队场景 · default audit scene',
      teamViewName: '采购团队场景 · audit team scene',
      description: 'Quick-save this scene-focused audit as a local view or promote it directly into team views.',
    })
  })

  it('falls back to scene id and recent-update naming', () => {
    expect(buildPlmAuditSceneSaveDraft({
      sceneId: 'scene-2',
      sceneName: '',
      sceneOwnerUserId: '',
      recommendationReason: 'recent-update',
    }, tr)).toEqual({
      savedViewName: 'scene-2 · recent-update audit scene',
      teamViewName: 'scene-2 · audit team scene',
      description: 'Quick-save this scene-focused audit as a local view or promote it directly into team views.',
    })
  })

  it('returns null without scene metadata', () => {
    expect(buildPlmAuditSceneSaveDraft({
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      recommendationReason: '',
    }, tr)).toBeNull()
  })
})
