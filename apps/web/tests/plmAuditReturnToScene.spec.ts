import { describe, expect, it } from 'vitest'
import { shouldShowPlmAuditPersistentReturnToScene } from '../src/views/plmAuditReturnToScene'

describe('plmAuditReturnToScene', () => {
  it('keeps a return CTA available whenever the route still carries a workbench return path', () => {
    expect(shouldShowPlmAuditPersistentReturnToScene({
      returnToPlmPath: '/plm?sceneFocus=scene-1',
      sceneContextVisible: false,
    })).toBe(true)
  })

  it('hides the persistent return CTA while the scene banner already exposes the same action', () => {
    expect(shouldShowPlmAuditPersistentReturnToScene({
      returnToPlmPath: '/plm?sceneFocus=scene-1',
      sceneContextVisible: true,
    })).toBe(false)

    expect(shouldShowPlmAuditPersistentReturnToScene({
      returnToPlmPath: '',
      sceneContextVisible: false,
    })).toBe(false)
  })
})
