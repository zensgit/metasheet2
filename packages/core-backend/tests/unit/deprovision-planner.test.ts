import { describe, expect, it } from 'vitest'
import { planDirectoryDeprovision } from '../../src/directory/deprovision-planner'

describe('planDirectoryDeprovision (D2 prospective)', () => {
  it('returns zero effects for pending_activation (no fake offboarding)', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u1',
      activationStatus: 'pending_activation',
      isActive: false,
      activeOrgIds: ['org-1'],
      dingtalkGrantEnabled: true,
      globallyClear: true,
    })
    expect(plan.effects).toEqual([])
    expect(plan.skipReason).toBe('pending_activation_no_offboarding_effects')
  })

  it('plans org clear + grant + inactive for activated globally-clear', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u2',
      activationStatus: 'activated',
      isActive: true,
      activeOrgIds: ['org-a', 'org-b'],
      dingtalkGrantEnabled: true,
      globallyClear: true,
    })
    expect(plan.skipReason).toBeNull()
    expect(plan.effects.map((e) => e.type).sort()).toEqual([
      'clear_user_orgs',
      'clear_user_orgs',
      'disable_dingtalk_grant',
      'set_user_inactive',
    ].sort())
    expect(plan.effects.every((e) => e.beforeActive === true && e.afterActive === false)).toBe(true)
  })

  it('zero-effect when already inactive with no orgs/grant', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u3',
      activationStatus: 'activated',
      isActive: false,
      activeOrgIds: [],
      dingtalkGrantEnabled: false,
      globallyClear: true,
    })
    expect(plan.effects).toEqual([])
    expect(plan.skipReason).toBe('zero_effect')
  })
})
