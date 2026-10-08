/**
 * D2 — prospective-only deprovision planner (design lock Rev 4.2 companion §4).
 *
 * Pure read model: compute intended effects without writing ledger or access graph.
 * Pending_activation users produce zero offboarding effects (no fake deprovision).
 */

export type DeprovisionEffectType = 'membership_changed' | 'grant_changed' | 'user_changed'
export type DirectoryDeprovisionPolicy =
  | 'manual_review'
  | 'disable_grant_only'
  | 'mark_inactive'

export const DIRECTORY_DEPROVISION_POLICIES: readonly DirectoryDeprovisionPolicy[] = [
  'manual_review',
  'disable_grant_only',
  'mark_inactive',
]

const DIRECTORY_DEPROVISION_POLICY_SEVERITY: Record<
  DirectoryDeprovisionPolicy,
  number
> = {
  manual_review: 0,
  disable_grant_only: 1,
  mark_inactive: 2,
}

/**
 * Unknown stored values fail closed to review-only. When several source
 * accounts are deactivated together, the least-destructive policy wins.
 */
export function resolveDirectoryDeprovisionPolicy(
  integrationDefault: string | null | undefined,
  accountOverride: string | null | undefined,
): DirectoryDeprovisionPolicy {
  const override = String(accountOverride ?? '').trim()
  const fallback = String(integrationDefault ?? '').trim()
  const candidate = override || fallback
  return (DIRECTORY_DEPROVISION_POLICIES as readonly string[]).includes(candidate)
    ? (candidate as DirectoryDeprovisionPolicy)
    : 'manual_review'
}

export function resolveLeastDestructiveDirectoryDeprovisionPolicy(
  integrationDefault: string | null | undefined,
  accountOverrides: Array<string | null | undefined>,
): DirectoryDeprovisionPolicy {
  const resolved = accountOverrides.length > 0
    ? accountOverrides.map((override) =>
        resolveDirectoryDeprovisionPolicy(integrationDefault, override),
      )
    : [
        resolveDirectoryDeprovisionPolicy(
          integrationDefault,
          undefined,
        ),
      ]
  return selectLeastDestructiveDirectoryDeprovisionPolicy(resolved)
}

/**
 * Select between policies that have already resolved their account overrides.
 * Keep this distinct from the resolver above: the integration default is a
 * fallback for an account without an override, not an extra veto candidate.
 */
export function selectLeastDestructiveDirectoryDeprovisionPolicy(
  policies: readonly DirectoryDeprovisionPolicy[],
): DirectoryDeprovisionPolicy {
  let selected = policies[0] ?? 'manual_review'
  for (const candidate of policies.slice(1)) {
    if (
      DIRECTORY_DEPROVISION_POLICY_SEVERITY[candidate]
      < DIRECTORY_DEPROVISION_POLICY_SEVERITY[selected]
    ) {
      selected = candidate
    }
  }
  return selected
}

export type PlannedEffect = {
  /**
   * Rev 4.4: TRUE when this grant_changed effect records the CREATION of an explicit disabled
   * grant row for a person who had NO row (the OPS-01 deny mark). Reversal DELETES the row
   * (restoring absence) instead of flipping enabled — closeout review P1: an unevidenced deny
   * row left a rehired never-granted person permanently locked out of OAuth.
   */
  grantRowCreated?: boolean
  type: DeprovisionEffectType
  orgId?: string | null
  beforeActive: boolean
  afterActive: boolean
}

export type DirectoryDeprovisionPlanInput = {
  localUserId: string
  policy: DirectoryDeprovisionPolicy
  activationStatus: string | null | undefined
  isActive: boolean
  /** Source integration org for this event. */
  orgId: string
  /** Whether the source org membership is currently active. */
  orgMembershipActive: boolean
  /** Whether DingTalk grant is currently enabled. */
  dingtalkGrantEnabled: boolean
  /** Whether ANY grant row exists (enabled or not) — drives the Rev 4.4 creation effect. */
  dingtalkGrantRowExists: boolean
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
  if (input.policy === 'manual_review') {
    return {
      localUserId: input.localUserId,
      skipReason: 'manual_review',
      effects: [],
    }
  }

  if (input.activationStatus === 'pending_activation') {
    return {
      localUserId: input.localUserId,
      skipReason: 'pending_activation_no_offboarding_effects',
      effects: [],
    }
  }
  if (input.activationStatus !== 'activated') {
    return {
      localUserId: input.localUserId,
      skipReason: 'unknown_activation_status',
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
    } else if (!input.dingtalkGrantRowExists) {
      // Rev 4.4: the OPS-01 deny mark IS an access-graph change (it blocks ensureGrant's
      // creation-only auto-grant on the person's next OAuth attempt) and therefore must be
      // EVIDENCED, or restore cannot undo it. before/after both false: nothing was enabled at
      // any point — the change is the row's existence, carried by grantRowCreated.
      effects.push({
        type: 'grant_changed',
        orgId: null,
        beforeActive: false,
        afterActive: false,
        grantRowCreated: true,
      })
    }
    if (input.policy === 'mark_inactive' && input.isActive) {
      effects.push({
        type: 'user_changed',
        orgId: null,
        beforeActive: true,
        afterActive: false,
      })
    }
  }

  // Drop no-ops (before==after) — prospective truth. A Rev 4.4 creation effect is NOT a no-op
  // even though both booleans are false: its change is the row's existence.
  const meaningful = effects.filter((e) => e.beforeActive !== e.afterActive || e.grantRowCreated === true)

  return {
    localUserId: input.localUserId,
    skipReason: meaningful.length === 0 ? 'zero_effect' : null,
    effects: meaningful,
  }
}
