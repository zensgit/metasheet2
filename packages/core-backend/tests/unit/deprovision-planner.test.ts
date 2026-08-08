import { describe, expect, it } from 'vitest'
import {
  planDirectoryDeprovision,
  resolveDirectoryDeprovisionPolicy,
  resolveLeastDestructiveDirectoryDeprovisionPolicy,
  selectLeastDestructiveDirectoryDeprovisionPolicy,
} from '../../src/directory/deprovision-planner'

describe('planDirectoryDeprovision (D2 prospective)', () => {
  it('returns zero effects for pending_activation (no fake offboarding)', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u1',
      policy: 'mark_inactive',
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

  it.each([null, '', 'suspended'])(
    'fails unknown activation status %j closed with zero effects',
    (activationStatus) => {
      const plan = planDirectoryDeprovision({
        localUserId: 'u-unknown',
        policy: 'mark_inactive',
        activationStatus,
        isActive: true,
        orgId: 'org-1',
        orgMembershipActive: true,
        dingtalkGrantEnabled: true,
        globallyClear: true,
      })
      expect(plan).toEqual({
        localUserId: 'u-unknown',
        skipReason: 'unknown_activation_status',
        effects: [],
      })
    },
  )

  it('plans one source-org membership + grant + user effect for globally-clear', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u2',
      policy: 'mark_inactive',
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
      policy: 'mark_inactive',
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

  // Rev 4.4 (closeout review P1): a globally-clear candidate with NO grant row is no longer
  // zero-effect — the OPS-01 deny mark is an access-graph change (it blocks ensureGrant's
  // creation-only auto-grant) and must be EVIDENCED so restore can delete the row again.
  it('already inactive with no orgs and NO grant row: plans the evidenced deny-row creation', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u3',
      policy: 'mark_inactive',
      activationStatus: 'activated',
      isActive: false,
      orgId: 'org-a',
      orgMembershipActive: false,
      dingtalkGrantEnabled: false,
      dingtalkGrantRowExists: false,
      globallyClear: true,
    })
    expect(plan.effects).toEqual([
      {
        type: 'grant_changed',
        orgId: null,
        beforeActive: false,
        afterActive: false,
        grantRowCreated: true,
      },
    ])
    expect(plan.skipReason).toBeNull()
  })

  it('zero-effect when already inactive with no orgs and the deny row already present', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u3',
      policy: 'mark_inactive',
      activationStatus: 'activated',
      isActive: false,
      orgId: 'org-a',
      orgMembershipActive: false,
      dingtalkGrantEnabled: false,
      dingtalkGrantRowExists: true,
      globallyClear: true,
    })
    expect(plan.effects).toEqual([])
    expect(plan.skipReason).toBe('zero_effect')
  })

  it('NOT globally clear never plans the deny-row creation (still employed elsewhere)', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u3',
      policy: 'mark_inactive',
      activationStatus: 'activated',
      isActive: false,
      orgId: 'org-a',
      orgMembershipActive: false,
      dingtalkGrantEnabled: false,
      dingtalkGrantRowExists: false,
      globallyClear: false,
    })
    expect(plan.effects).toEqual([])
    expect(plan.skipReason).toBe('zero_effect')
  })

  it('disable_grant_only never plans a platform-user effect', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u-grant-only',
      policy: 'disable_grant_only',
      activationStatus: 'activated',
      isActive: true,
      orgId: 'org-a',
      orgMembershipActive: true,
      dingtalkGrantEnabled: true,
      globallyClear: true,
    })
    expect(plan.effects.map((effect) => effect.type).sort()).toEqual(
      ['membership_changed', 'grant_changed'].sort(),
    )
  })

  it('manual_review is always a zero-write plan', () => {
    const plan = planDirectoryDeprovision({
      localUserId: 'u-review',
      policy: 'manual_review',
      activationStatus: 'activated',
      isActive: true,
      orgId: 'org-a',
      orgMembershipActive: true,
      dingtalkGrantEnabled: true,
      globallyClear: true,
    })
    expect(plan).toEqual({
      localUserId: 'u-review',
      skipReason: 'manual_review',
      effects: [],
    })
  })

  it('fails unknown stored policies closed and selects the least-destructive override', () => {
    expect(resolveDirectoryDeprovisionPolicy('unknown', null)).toBe(
      'manual_review',
    )
    expect(
      resolveLeastDestructiveDirectoryDeprovisionPolicy('mark_inactive', [
        'disable_grant_only',
        'manual_review',
      ]),
    ).toBe('manual_review')
  })

  it('treats the integration default as an account fallback, not a preview veto', () => {
    expect(
      resolveLeastDestructiveDirectoryDeprovisionPolicy('manual_review', [
        'mark_inactive',
      ]),
    ).toBe('mark_inactive')
    expect(
      resolveLeastDestructiveDirectoryDeprovisionPolicy('disable_grant_only', []),
    ).toBe('disable_grant_only')
    expect(
      selectLeastDestructiveDirectoryDeprovisionPolicy([
        'mark_inactive',
        'manual_review',
      ]),
    ).toBe('manual_review')
  })
})
