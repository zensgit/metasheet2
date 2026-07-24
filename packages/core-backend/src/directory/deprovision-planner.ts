/**
 * D2 — prospective-only deprovision planner (design lock Rev 4.2 companion §4).
 *
 * Pure read model: compute intended effects without writing ledger or access graph.
 * Pending_activation users produce zero offboarding effects (no fake deprovision).
 *
 * D4 amendment: the plan must be the SAME decision the writer takes, or "Apply≈Plan" (§11) is
 * unverifiable and the preview lies. Two gates the first cut did not model:
 *   - `policy` — `manual_review` never writes anything, and only `mark_inactive` may touch
 *     `users.is_active` (`disable_grant_only` stops at the grant).
 *   - the org-scoped / globally-clear split (W4-PRE-1d): org membership is deactivated for every
 *     org-membership candidate, but the grant and the platform user are gated on the person
 *     having no active binding ANYWHERE.
 * Effect names are the §5.2 enum (the DB CHECK constraint is the authority), and there is at most
 * one effect per type per event — `UNIQUE (event_id, effect_type)`.
 */

export type DeprovisionEffectType =
  | 'membership_changed'
  | 'grant_changed'
  | 'user_changed'

export type DeprovisionPolicy = 'manual_review' | 'disable_grant_only' | 'mark_inactive'

export type PlannedEffect = {
  type: DeprovisionEffectType
  /** §5.2 CHECK: NOT NULL for membership_changed, NULL for the other two. */
  orgId: string | null
  beforeActive: boolean
  afterActive: boolean
}

export type DirectoryDeprovisionPlanInput = {
  localUserId: string
  policy: DeprovisionPolicy
  activationStatus: string | null | undefined
  /** Org whose membership this run would deactivate (the integration's org). */
  membershipOrgId: string | null
  /** Whether that membership is currently active — a no-op flip is not an effect. */
  membershipActive: boolean
  /** Whether the DingTalk grant is currently enabled (`user_external_auth_grants`). */
  dingtalkGrantEnabled: boolean
  /** Whether the platform user is currently active. */
  userActive: boolean
  /** No active linked directory account ANYWHERE — gates grant + platform-user effects only. */
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

  // Owner 裁决② (#4522 rev3): manual_review keeps membership active and exposes a pending state
  // — it is never a write, so it can never produce a ledger effect either.
  if (input.policy === 'manual_review') {
    return {
      localUserId: input.localUserId,
      skipReason: 'manual_review_no_write',
      effects: [],
    }
  }

  const effects: PlannedEffect[] = []

  // W4-PRE-1d item 1: org-scoped, NOT gated on globallyClear.
  if (input.membershipOrgId && input.membershipActive) {
    effects.push({
      type: 'membership_changed',
      orgId: input.membershipOrgId,
      beforeActive: true,
      afterActive: false,
    })
  }

  // W4-PRE-1d item 2: grant + platform user require "no active binding anywhere".
  if (input.globallyClear && input.dingtalkGrantEnabled) {
    effects.push({
      type: 'grant_changed',
      orgId: null,
      beforeActive: true,
      afterActive: false,
    })
  }

  if (input.globallyClear && input.policy === 'mark_inactive' && input.userActive) {
    effects.push({
      type: 'user_changed',
      orgId: null,
      beforeActive: true,
      afterActive: false,
    })
  }

  // Drop no-ops (before==after) — prospective truth.
  const meaningful = effects.filter((e) => e.beforeActive !== e.afterActive)

  return {
    localUserId: input.localUserId,
    skipReason: meaningful.length === 0 ? 'zero_effect' : null,
    effects: meaningful,
  }
}
