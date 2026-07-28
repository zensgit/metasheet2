/**
 * D2 — prospective-only deprovision planner (design lock Rev 4.2 companion §4).
 *
 * Pure read model: compute intended effects without writing ledger or access graph.
 * Pending_activation users produce zero offboarding effects (no fake deprovision).
 */

export type DeprovisionEffectType =
  | 'clear_user_orgs'
  | 'disable_dingtalk_grant'
  | 'set_user_inactive'

export type PlannedEffect = {
  type: DeprovisionEffectType
  orgId?: string | null
  beforeActive: boolean
  afterActive: boolean
}

export type DirectoryDeprovisionPlanInput = {
  localUserId: string
  activationStatus: string | null | undefined
  isActive: boolean
  /** Current active user_org memberships for this user. */
  activeOrgIds: string[]
  /** Whether DingTalk grant is currently enabled. */
  dingtalkGrantEnabled: boolean
  /** Policy: when true, plan will clear all orgs + grant + is_active. */
  globallyClear: boolean
}

export type DirectoryDeprovisionPlan = {
  localUserId: string
  skipReason: string | null
  effects: PlannedEffect[]
}

/**
 * Prospective planner: pending users never invent offboarding effects.
 */
export function planDirectoryDeprovision(
  input: DirectoryDeprovisionPlanInput,
): DirectoryDeprovisionPlan {
  if (input.activationStatus === 'pending_activation') {
    return {
      localUserId: input.localUserId,
      skipReason: 'pending_activation_no_offboarding_effects',
      effects: [],
    }
  }

  const effects: PlannedEffect[] = []

  if (input.globallyClear) {
    for (const orgId of input.activeOrgIds) {
      effects.push({
        type: 'clear_user_orgs',
        orgId,
        beforeActive: true,
        afterActive: false,
      })
    }
    if (input.dingtalkGrantEnabled) {
      effects.push({
        type: 'disable_dingtalk_grant',
        beforeActive: true,
        afterActive: false,
      })
    }
    if (input.isActive) {
      effects.push({
        type: 'set_user_inactive',
        beforeActive: true,
        afterActive: false,
      })
    }
  }

  // Drop no-ops (before==after) — prospective truth.
  const meaningful = effects.filter((e) => e.beforeActive !== e.afterActive)

  return {
    localUserId: input.localUserId,
    skipReason: meaningful.length === 0 ? 'zero_effect' : null,
    effects: meaningful,
  }
}
