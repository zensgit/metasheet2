/**
 * D2 — prospective-only deprovision planner (design lock Rev 4.2 companion §4).
 *
 * Pure read model: compute intended effects without writing ledger or access graph.
 * Pending_activation users produce zero offboarding effects (no fake deprovision).
 */

export type DeprovisionEffectType = 'membership_changed' | 'grant_changed' | 'user_changed'

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
  /** Source integration org for this event. */
  orgId: string
  /** Whether the source org membership is currently active. */
  orgMembershipActive: boolean
  /** Whether DingTalk grant is currently enabled. */
  dingtalkGrantEnabled: boolean
  /**
   * No other active linked directory account exists anywhere. This gates the
   * grant/user effects only; the source-org membership is independently scoped.
   */
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
export function planDirectoryDeprovision(input: DirectoryDeprovisionPlanInput): DirectoryDeprovisionPlan {
  if (input.activationStatus === 'pending_activation') {
    return {
      localUserId: input.localUserId,
      skipReason: 'pending_activation_no_offboarding_effects',
      effects: [],
    }
  }

  const effects: PlannedEffect[] = []

  if (input.orgMembershipActive) {
    effects.push({
      type: 'membership_changed',
      orgId: input.orgId,
      beforeActive: true,
      afterActive: false,
    })
  }

  if (input.globallyClear) {
    if (input.dingtalkGrantEnabled) {
      effects.push({
        type: 'grant_changed',
        orgId: null,
        beforeActive: true,
        afterActive: false,
      })
    }
    if (input.isActive) {
      effects.push({
        type: 'user_changed',
        orgId: null,
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
