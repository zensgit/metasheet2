import { describe, expect, it } from 'vitest'
import { planDirectoryDeprovision } from '../../src/directory/deprovision-planner'

describe('planDirectoryDeprovision (D2 prospective)', () => {
  it('returns zero effects for pending_activation (no fake offboarding)', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u1',
      activationStatus: 'pending_activation',
      isActive: false,
      orgId: 'org-1',
      orgMembershipActive: false,
      dingtalkGrantEnabled: true,
      globallyClear: true,
    })
    expect(plan.effects).toEqual([])
    expect(plan.skipReason).toBe('pending_activation_no_offboarding_effects')
  })

  it('plans one source-org membership + grant + user effect for globally-clear', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u2',
      activationStatus: 'activated',
      isActive: true,
      orgId: 'org-a',
      orgMembershipActive: true,
      dingtalkGrantEnabled: true,
      globallyClear: true,
    })
    expect(plan.skipReason).toBeNull()
    expect(plan.effects.map((e) => e.type).sort()).toEqual(
      ['membership_changed', 'grant_changed', 'user_changed'].sort(),
    )
    expect(plan.effects.find((e) => e.type === 'membership_changed')?.orgId).toBe('org-a')
    expect(plan.effects.every((e) => e.beforeActive === true && e.afterActive === false)).toBe(true)
  })

  it('keeps the source-org membership effect while another org preserves global access', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u-cross-org',
      activationStatus: 'activated',
      isActive: true,
      orgId: 'org-a',
      orgMembershipActive: true,
      dingtalkGrantEnabled: true,
      globallyClear: false,
    })
    expect(plan.effects).toEqual([
      {
        type: 'membership_changed',
        orgId: 'org-a',
        beforeActive: true,
        afterActive: false,
      },
    ])
  })

  it('zero-effect when already inactive with no orgs/grant', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u3',
      activationStatus: 'activated',
      isActive: false,
      orgId: 'org-a',
      orgMembershipActive: false,
      dingtalkGrantEnabled: false,
      globallyClear: true,
    })
    expect(plan.effects).toEqual([])
    expect(plan.skipReason).toBe('zero_effect')
  })
})
