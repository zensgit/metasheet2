import { describe, expect, it } from 'vitest'
import {
  isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1,
  isAttendanceGroupEffectivePolicyPanelMasterEnabled,
} from '../../src/attendance/w6-group-effective-policy-panel-flag'

/**
 * W6-3 (#4556) OD-W6-7=(a): the panel's two-layer, default-OFF gate.
 * Governing document: docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md §5/§9.
 */
describe('attendance group effective-policy panel gate (OD-W6-7)', () => {
  describe('master switch layer', () => {
    it.each([
      [{}, false],
      [{ ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: '' }, false],
      [{ ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: '1' }, false],
      [{ ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: 'false' }, false],
      [{ ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: ' true ' }, true],
      [{ ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: 'TRUE' }, true],
    ] as const)('is explicit and defaults off', (env, expected) => {
      expect(isAttendanceGroupEffectivePolicyPanelMasterEnabled(env as NodeJS.ProcessEnv)).toBe(expected)
    })
  })

  describe('combined org-scoped predicate', () => {
    const ORG_A = 'org-a'
    const ORG_B = 'org-b'

    it('is false with no env set at all (default OFF, byte-identical)', () => {
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(ORG_A, {})).toBe(false)
    })

    it('is false when the master switch is on but the org is not allowlisted', () => {
      const env = { ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: 'true' } as NodeJS.ProcessEnv
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(ORG_A, env)).toBe(false)
    })

    it('is false when the org is allowlisted but the master switch is off', () => {
      const env = { ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ORGS: ORG_A } as NodeJS.ProcessEnv
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(ORG_A, env)).toBe(false)
    })

    it('is true only for an org present in the exact allowlist with the master switch on', () => {
      const env = {
        ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: 'true',
        ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ORGS: `${ORG_A}, ${ORG_B}`,
      } as NodeJS.ProcessEnv
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(ORG_A, env)).toBe(true)
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(ORG_B, env)).toBe(true)
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1('org-c', env)).toBe(false)
    })

    it('never treats a wildcard entry as a match', () => {
      const env = {
        ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: 'true',
        ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ORGS: '*',
      } as NodeJS.ProcessEnv
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(ORG_A, env)).toBe(false)
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1('*', env)).toBe(true)
    })

    it('fails closed for a null/undefined/blank orgId even with both layers on', () => {
      const env = {
        ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED: 'true',
        ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ORGS: ORG_A,
      } as NodeJS.ProcessEnv
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(null, env)).toBe(false)
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(undefined, env)).toBe(false)
      expect(isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1('   ', env)).toBe(false)
    })
  })
})
